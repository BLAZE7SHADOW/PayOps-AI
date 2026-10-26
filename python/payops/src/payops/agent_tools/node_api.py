"""The agent graph's door into the backend, as direct calls. It answers exactly what the `/internal/agent` routes used to answer, so the graph code does not
change; there is no HTTP hop, no shared secret and no second service. (packages/agents remote.ts, apps/server routes/internal-agent.ts)"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from pydantic import TypeAdapter

from ..domain.actions.types import CaseState
from ..dto.actions import CatalogAction
from ..errors import AppError
from ..infra.snapshots import load_case_state
from ..services.writes.resolutions import agent_write_context
from .brief import build_case_brief
from .proposal import build_proposal, to_attempt_history
from .store import AgentStore
from .tools import TOOLS_BY_NAME

if TYPE_CHECKING:
    from ..container import Services

_ACTIONS: TypeAdapter[list[CatalogAction]] = TypeAdapter(list[CatalogAction])


class InProcessNodeApi:
    def __init__(self, services: Services, store: AgentStore) -> None:
        self._services = services
        self._store = store

    async def _state(self, case_id: str) -> CaseState:
        async with self._services.sessions() as s:
            return await load_case_state(s, self._services.gateway, case_id, self._services.clock.now())

    async def case_brief(self, case_id: str) -> dict[str, Any]:
        state = await self._state(case_id)
        return {"brief": build_case_brief(state), "entityRefs": state.case.entity_refs}

    async def run_tools(self, case_id: str, tools: list[str]) -> list[dict[str, Any]]:
        """Runs the named tools, in the order given, over one fresh read of the case."""
        chosen = []
        for name in tools:
            if name not in TOOLS_BY_NAME:
                raise AppError("BAD_REQUEST", f"Unknown tool {name}")
            chosen.append(TOOLS_BY_NAME[name])
        state = await self._state(case_id)
        return [{"tool": t.name, "drafts": t.run(state)} for t in chosen]

    async def proposal(self, case_id: str, diagnosis: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
        return build_proposal(diagnosis, await self._state(case_id), to_attempt_history(history))

    async def policy_gate(self, case_id: str, run_id: str, proposal: dict[str, Any], diagnosis_confidence: float) -> dict[str, Any]:
        result = await self._services.resolution_service.propose_from_agent(
            case_id, run_id, _ACTIONS.validate_python(proposal["actions"]), proposal["rationale"], diagnosis_confidence=diagnosis_confidence, grounding_violations=0
        )
        r = result.resolution
        return {"resolutionId": r.id, "policy": r.policy, "attempt": r.attempt, "approvalId": result.approval_id}

    async def execute(self, case_id: str, run_id: str, resolution_id: str) -> dict[str, Any]:
        """The `execute` node's body: run the actions, and close the run out when execution fails."""
        resolutions = self._services.resolution_service
        write = agent_write_context(case_id, run_id)
        try:
            outcome = await resolutions.execute(resolution_id, write)
            steps = [s.to_json() for s in outcome.steps]
            if not outcome.ok:
                await resolutions.close_execution_failed(resolution_id, outcome, write, on_failure="ESCALATE")
                return {"outcome": "FAILED", "steps": steps}
            return {"outcome": "OK", "steps": steps}
        except Exception as err:  # noqa: BLE001 - any failure of the executor itself closes the resolution as escalated
            message = err.message if isinstance(err, AppError) else (str(err) or type(err).__name__)
            await resolutions.escalate_execution_error(resolution_id, message, write)
            return {"outcome": "ERROR", "message": message}

    async def validate(self, resolution_id: str) -> dict[str, Any]:
        row = await self._services.resolution_service.validate(resolution_id)
        return {"verdict": row.verdict, "checks": row.checks}

    async def close_validated(self, case_id: str, run_id: str, resolution_id: str, verdict: str) -> None:
        await self._services.resolution_service.close_validated(resolution_id, verdict, agent_write_context(case_id, run_id), on_failure="ESCALATE")

    async def escalate_without_proposal(self, case_id: str, run_id: str, reason: str) -> None:
        await self._services.resolution_service.escalate_without_proposal(case_id, reason, agent_write_context(case_id, run_id))

    async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None:
        await self._store.record_step(run_id, case_id, node, kind, payload)

    async def sync(self, run_id: str, case_id: str, state: dict[str, Any], interrupted: bool) -> None:
        await self._store.sync_run(run_id, case_id, state, interrupted)

    async def fail(self, run_id: str, error: str) -> None:
        await self._store.fail_run(run_id, error)
