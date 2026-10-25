"""Entry points: start a run, or resume one paused at `awaitApproval` (packages/agents run.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from langgraph.types import Command

from .constants import RECURSION_LIMIT
from .graph import build_graph
from .node_api import NodeApiPort, make_event_sink
from .nodes import AgentDeps
from .ports import FixtureOptions, ModelEnv, NoLlm, RetryNotice, create_decision_port, create_llm_port, fixture_decision
from .state import initial_state

DECISION_NODE = {"J2_PLAN": "plan", "J3_RISK": "riskAgent", "J4_GROUND": "groundCheck", "J5_REPLAN": "replan", "J6_DIAGNOSE": "diagnose"}

SYNC_KEYS = (
    "status", "diagnosis", "resolutionId", "approvalId", "attempt", "budget", "evidence", "findings", "proposal", "policy", "grounding",
)


@dataclass
class RunResult:
    status: str
    interrupted: bool
    state: dict[str, Any]
    # REPLAY only: how many recorded calls matched exactly and how many needed the nearest-recording fallback.
    replay: dict[str, dict[str, int]] | None = None


def _replay_stats(deps: AgentDeps) -> dict[str, dict[str, int]] | None:
    from .ports import ReplayDecision, ReplayLlm

    if not isinstance(deps.llm, ReplayLlm) or not isinstance(deps.decision, ReplayDecision):
        return None
    return {
        "llm": {"exact": deps.llm.reader.exact_hits, "fallback": deps.llm.reader.fallback_hits},
        "jev": {"exact": deps.decision.reader.exact_hits, "fallback": deps.decision.reader.fallback_hits},
    }


class AgentRunner:
    def __init__(self, api: NodeApiPort, checkpointer: Any) -> None:
        self._api = api
        self._checkpointer = checkpointer

    def _deps(
        self, run_id: str, case_id: str, ai_mode: str, scenario_key: str | None, model_env: ModelEnv | None = None,
        fixture: FixtureOptions | None = None,
    ) -> AgentDeps:
        on_event = make_event_sink(self._api, run_id, case_id)

        async def on_retry(notice: RetryNotice) -> None:
            node = DECISION_NODE.get(notice.step or "", notice.step or "model")
            await on_event(
                node, "MODEL_RETRY",
                {
                    "provider": notice.provider, "attempt": notice.attempt, "maxAttempts": notice.max_attempts,
                    "delayMs": notice.delay_ms, "reason": notice.reason,
                },
            )

        if fixture is not None:
            return AgentDeps(api=self._api, llm=NoLlm(), decision=fixture_decision(fixture), on_event=on_event)
        env = model_env or ModelEnv.from_environ(ai_mode)
        return AgentDeps(
            api=self._api,
            llm=create_llm_port(env, scenario_key, on_retry),
            decision=create_decision_port(env, scenario_key, on_retry),
            on_event=on_event,
        )

    async def _invoke(self, run_id: str, case_id: str, deps: AgentDeps, payload: Any) -> RunResult:
        graph = build_graph(deps, self._checkpointer)
        config = {"configurable": {"thread_id": run_id}, "recursion_limit": RECURSION_LIMIT}
        try:
            result = await graph.ainvoke(payload, config)
            interrupted = bool(result.get("__interrupt__"))
            await self._api.sync(run_id, case_id, {k: result[k] for k in SYNC_KEYS if k in result}, interrupted)
            full = {k: v for k, v in result.items() if k != "__interrupt__"}
            return RunResult(str(result.get("status", "")), interrupted, full, _replay_stats(deps))
        except Exception as err:
            await self._api.fail(run_id, str(err))
            raise

    async def investigate(
        self, run_id: str, case_id: str, scenario_key: str | None, ai_mode: str, model_env: ModelEnv | None = None,
        fixture: FixtureOptions | None = None,
    ) -> RunResult:
        deps = self._deps(run_id, case_id, ai_mode, scenario_key, model_env, fixture)
        return await self._invoke(run_id, case_id, deps, initial_state(case_id, run_id, ai_mode, scenario_key))

    async def resume(
        self, run_id: str, case_id: str, scenario_key: str | None, ai_mode: str, decision: dict[str, Any],
        model_env: ModelEnv | None = None, fixture: FixtureOptions | None = None,
    ) -> RunResult:
        deps = self._deps(run_id, case_id, ai_mode, scenario_key, model_env, fixture)
        resume_value = {
            "approvalId": decision.get("approvalId"),
            "decision": decision["decision"],
            "decidedBy": decision.get("decidedBy"),
            "comment": decision.get("comment"),
        }
        return await self._invoke(run_id, case_id, deps, Command(resume=resume_value))
