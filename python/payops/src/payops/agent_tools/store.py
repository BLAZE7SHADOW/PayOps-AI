"""Persistence for `agent_runs`, `agent_steps`, `evidence` and `agent_findings`, and the realtime event each step
produces. Only the graph writes these tables; the read side is `services/runs.py`. (packages/agents store.ts, run.ts)"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.engine import transaction
from ..db.models import AgentFinding, AgentRun, AgentStep, Evidence
from ..domain.ids import new_id
from ..domain.timeutil import to_iso
from ..errors import AppError
from ..ports import Clock, EventPublisher
from ..realtime import ROOM_OPS, room_case

log = logging.getLogger("payops.agents")

ZERO_BUDGET = {"llmCalls": 0, "jevCalls": 0, "toolCalls": 0, "tokensIn": 0, "tokensOut": 0, "costUsd": 0}

#: Maps our step kinds to the realtime event names in docs/03 §16.
STEP_EVENT = {
    "NODE_STARTED": "node.started", "NODE_COMPLETED": "node.completed", "TOOL_CALLED": "tool.called", "TOOL_COMPLETED": "tool.completed",
    "DECISION_MADE": "decision.made", "LLM_CALLED": "node.completed", "MODEL_RETRY": "model.retry", "FINDING_CREATED": "finding.created",
    "PROPOSAL_CREATED": "proposal.created", "POLICY_DECIDED": "policy.decided", "APPROVAL_REQUESTED": "approval.requested",
    "APPROVAL_RESOLVED": "approval.resolved", "EXECUTION_STEP": "execution.step", "VALIDATION_COMPLETED": "validation.completed",
    "RUN_REPLANNING": "run.replanning", "RUN_COMPLETED": "run.completed", "RUN_FAILED": "run.failed",
}  # fmt: skip

#: Run row columns a patch may set, by the name the graph state uses.
_COLUMN = {
    "status": "status",
    "path": "path",
    "resolutionId": "resolution_id",
    "approvalId": "approval_id",
    "attempt": "attempt",
    "scenarioKey": "scenario_key",
    "budget": "budget",
    "evidence": "evidence",
    "findings": "findings",
    "diagnosis": "diagnosis",
    "proposal": "proposal",
    "policy": "policy",
    "grounding": "grounding",
    "error": "error",
    "finishedAt": "finished_at",
}


class AgentStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], clock: Clock, events: EventPublisher) -> None:
        self._sessions = sessions
        self._clock = clock
        self._events = events

    async def create_run(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        now = self._clock.now()
        async with transaction(self._sessions) as s:
            s.add(
                AgentRun(
                    id=run_id,
                    case_id=case_id,
                    scenario_key=scenario_key,
                    status="INVESTIGATING",
                    path=None,
                    attempt=1,
                    budget=ZERO_BUDGET,
                    evidence=[],
                    findings=[],
                    diagnosis=None,
                    proposal=None,
                    policy=None,
                    grounding=None,
                    created_at=now,
                    updated_at=now,
                    resolution_id=None,
                    approval_id=None,
                    error=None,
                    finished_at=None,
                )
            )

    async def patch_run(self, run_id: str, patch: dict[str, Any]) -> None:
        values = {_COLUMN[k]: v for k, v in patch.items()}
        async with transaction(self._sessions) as s:
            await s.execute(
                update(AgentRun).where(AgentRun.id == run_id).values(**values, updated_at=self._clock.now())
            )

    async def get_run(self, run_id: str) -> AgentRun | None:
        async with self._sessions() as s:
            return await s.get(AgentRun, run_id)

    async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None:
        """One `agent_steps` row plus its realtime event."""
        at = self._clock.now()
        async with transaction(self._sessions) as s:
            seq = (
                await s.execute(select(func.count()).select_from(AgentStep).where(AgentStep.run_id == run_id))
            ).scalar_one() + 1
            s.add(
                AgentStep(id=new_id("agentStep"), run_id=run_id, seq=seq, node=node, kind=kind, payload=payload, at=at)
            )
        envelope = {"runId": run_id, "caseId": case_id, "node": node, "at": to_iso(at), "seq": seq, "data": payload}
        event = STEP_EVENT.get(kind, "node.completed")
        self._events.publish(ROOM_OPS, event, envelope)
        self._events.publish(room_case(case_id), event, envelope)

    async def sync_run(self, run_id: str, case_id: str, state: dict[str, Any], interrupted: bool) -> None:
        """Copies the graph's final (or paused) state onto the run row and fans the evidence and findings out into their
        own tables. Safe to repeat: a run can pause and resume, so this runs more than once for the same run, and every
        write is an upsert."""
        patch: dict[str, Any] = {
            k: state[k] for k in ("status", "resolutionId", "approvalId", "attempt", "budget") if k in state
        }
        patch["path"] = (state.get("diagnosis") or {}).get("path")
        for key in ("evidence", "findings"):
            patch[key] = state.get(key) or []
        for key in ("diagnosis", "proposal", "policy", "grounding"):
            patch[key] = state.get(key)
        patch["resolutionId"] = state.get("resolutionId")
        patch["approvalId"] = state.get("approvalId")
        patch["finishedAt"] = None if interrupted else self._clock.now()
        await self.patch_run(run_id, patch)
        await self._sync_evidence_and_findings(
            run_id, case_id, state.get("evidence") or [], state.get("findings") or [], state.get("grounding")
        )

    async def _sync_evidence_and_findings(
        self,
        run_id: str,
        case_id: str,
        evidence: list[dict[str, Any]],
        findings: list[dict[str, Any]],
        grounding: dict[str, Any] | None,
    ) -> None:
        now = self._clock.now()
        dropped = {v["findingId"] for v in (grounding or {}).get("violations", [])}
        async with transaction(self._sessions) as s:
            for item in evidence:
                values = {
                    "source": item["source"],
                    "system": item["system"],
                    "entity_ref": item["entityRef"],
                    "facts": item["facts"],
                    "step_id": item["stepId"],
                }
                await s.execute(
                    pg_insert(Evidence)
                    .values(id=new_id("evidenceRow"), run_id=run_id, evidence_id=item["id"], created_at=now, **values)
                    .on_conflict_do_update(index_elements=[Evidence.run_id, Evidence.evidence_id], set_=values)
                )
            for f in findings:
                # A finding is grounded until a violation names it. Findings J4 never checked (fast path) are therefore
                # grounded too.
                values = {
                    "agent": f["agent"],
                    "code": f["code"],
                    "statement": f["statement"],
                    "evidence_ids": f["evidenceIds"],
                    "confidence": f["confidence"],
                    "grounded": f["id"] not in dropped,
                    "updated_at": now,
                }
                await s.execute(
                    pg_insert(AgentFinding)
                    .values(
                        id=new_id("agentFinding"),
                        run_id=run_id,
                        case_id=case_id,
                        finding_id=f["id"],
                        created_at=now,
                        **values,
                    )
                    .on_conflict_do_update(index_elements=[AgentFinding.run_id, AgentFinding.finding_id], set_=values)
                )

    async def fail_run(self, run_id: str, error: str) -> None:
        await self.patch_run(run_id, {"status": "FAILED", "error": error, "finishedAt": self._clock.now()})


async def create_agent_run(services: Any, store: AgentStore, case_id: str, scenario_key: str | None) -> str:
    """Creates the run row so `{runId}` can be returned at once. While an operator has the agent paused no new
    investigation starts (D066); people can still resolve cases by hand, so nothing else is blocked."""
    async with services.sessions() as s:
        control = await services.agent_control.get(s)
    if control.mode == "PAUSED":
        why = f": {control.reason}" if control.reason else "."
        raise AppError("CONFLICT", f"The agent is paused{why} Resolve the case by hand or ask a manager to resume it.")
    run_id = new_id("run")
    await store.create_run(run_id, case_id, scenario_key)
    return run_id
