"""Whole runs of the graph against a recorded cassette, with the TypeScript API replaced by a fake."""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from payops_agents.node_api import make_event_sink
from payops_agents.nodes import AgentDeps
from payops_agents.ports import ModelEnv, ReplayDecision, ReplayLlm
from payops_agents.run import AgentRunner
from tests.fakes import FakeNodeApi

REPLAY = ModelEnv(ai_mode="REPLAY")


def runner(api: FakeNodeApi) -> AgentRunner:
    return AgentRunner(api, InMemorySaver())  # type: ignore[arg-type]


async def test_a_recorded_case_resolves_with_every_prompt_matching_its_recording() -> None:
    api = FakeNodeApi()
    result = await runner(api).investigate("run_a", api.data["caseId"], "captured_order_failed", "REPLAY")
    assert result.status == "RESOLVED" and not result.interrupted
    # Exact hits only: a fallback would mean a prompt or Jev request differs from the TypeScript one.
    assert result.replay and result.replay["llm"]["fallback"] == 0 and result.replay["jev"]["fallback"] == 0
    assert result.replay["jev"]["exact"] >= 3 and result.replay["llm"]["exact"] >= 1
    assert api.closed == [("res_fake", "PASS")]
    assert result.state["diagnosis"]["rootCause"] == "WEBHOOK_PROCESSING_FAILURE"
    assert result.state["budget"]["toolCalls"] > 0


async def test_steps_are_recorded_in_graph_order_and_the_run_is_synced_once() -> None:
    api = FakeNodeApi()
    await runner(api).investigate("run_b", api.data["caseId"], "captured_order_failed", "REPLAY")
    nodes = [n for n, _ in api.steps]
    assert nodes[0] == "loadCase" and nodes.index("triage") < nodes.index("diagnose") < nodes.index("resolve") < nodes.index("policyGate")
    assert ("validate", "VALIDATION_COMPLETED") in api.steps and api.steps[-1] == ("close", "RUN_COMPLETED") or ("closeResolved", "RUN_COMPLETED") == api.steps[-1]
    assert len(api.synced) == 1 and api.synced[0][1] is False
    assert api.synced[0][0]["status"] == "RESOLVED"


async def test_a_manager_tier_run_pauses_for_approval_and_resumes_on_the_decision() -> None:
    api = FakeNodeApi(tier="MANAGER")
    r = runner(api)
    paused = await r.investigate("run_c", api.data["caseId"], "captured_order_failed", "REPLAY")
    assert paused.interrupted and paused.status == "AWAITING_APPROVAL"
    assert "execute" not in api.calls and api.synced[0][1] is True
    done = await r.resume("run_c", api.data["caseId"], "captured_order_failed", "REPLAY", {"approvalId": "apr_fake", "decision": "APPROVE"})
    assert done.status == "RESOLVED" and not done.interrupted and "execute" in api.calls


async def test_a_rejected_approval_closes_the_run_without_executing() -> None:
    api = FakeNodeApi(tier="OPS")
    r = runner(api)
    await r.investigate("run_d", api.data["caseId"], "captured_order_failed", "REPLAY")
    done = await r.resume("run_d", api.data["caseId"], "captured_order_failed", "REPLAY", {"approvalId": "apr_fake", "decision": "REJECT"})
    assert done.status == "REJECTED" and "execute" not in api.calls


async def test_a_failed_validation_replans_through_jev_and_stops_at_the_attempt_cap() -> None:
    api = FakeNodeApi(verdicts=["FAIL"])
    result = await runner(api).investigate("run_e", api.data["caseId"], "captured_order_failed", "REPLAY")
    # The recording has no J5 answer, so replan falls back to escalation (the documented J5 fallback).
    assert result.status == "ESCALATED"
    assert api.closed[-1][1] == "FAIL"
    assert any(kind == "NODE_COMPLETED" and node == "replan" for node, kind in api.steps)


async def test_a_run_that_raises_is_reported_to_the_api_and_re_raised() -> None:
    api = FakeNodeApi()

    async def boom(case_id: str) -> dict[str, Any]:
        raise RuntimeError("api down")

    api.case_brief = boom  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="api down"):
        await runner(api).investigate("run_f", "case_x", "captured_order_failed", "REPLAY")
    assert api.failed == ["api down"]


async def test_events_are_posted_one_at_a_time_so_step_numbers_stay_ordered() -> None:
    import asyncio

    in_flight = 0
    peak = 0

    class SlowApi(FakeNodeApi):
        async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None:
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.001)
            in_flight -= 1

    api = SlowApi()
    sink = make_event_sink(api, "run_g", "case_g")  # type: ignore[arg-type]
    await asyncio.gather(*(sink("n", "NODE_STARTED", {}) for _ in range(10)))
    assert peak == 1


def test_replay_ports_read_the_shared_cassette_directory() -> None:
    llm, decision = ReplayLlm("captured_order_failed"), ReplayDecision("captured_order_failed")
    assert llm.reader.paths[0].name == "captured_order_failed.jsonl" and llm.reader.paths[0].exists()
    assert decision.reader.paths == llm.reader.paths
    assert AgentDeps  # imported for the type; the runner builds deps from the environment
    assert REPLAY.ai_mode == "REPLAY"


async def test_a_second_start_while_the_run_is_executing_is_refused() -> None:
    import asyncio

    from payops_agents.run import RunConflict

    release = asyncio.Event()

    class SlowApi(FakeNodeApi):
        async def case_brief(self, case_id: str) -> dict[str, Any]:
            await release.wait()
            return await super().case_brief(case_id)

    api = SlowApi()
    r = runner(api)
    first = asyncio.create_task(r.investigate("run_h", api.data["caseId"], "captured_order_failed", "REPLAY"))
    await asyncio.sleep(0.01)
    with pytest.raises(RunConflict):
        await r.investigate("run_h", api.data["caseId"], "captured_order_failed", "REPLAY")
    release.set()
    assert (await first).status == "RESOLVED"


async def test_a_run_that_stopped_part_way_continues_from_its_checkpoint() -> None:
    api = FakeNodeApi()
    calls = {"n": 0}
    original = api.run_tools

    async def flaky(case_id: str, tools: list[str]) -> list[dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("api went away")
        return await original(case_id, tools)

    api.run_tools = flaky  # type: ignore[method-assign]
    r = runner(api)
    with pytest.raises(RuntimeError):
        await r.investigate("run_i", api.data["caseId"], "captured_order_failed", "REPLAY")
    assert api.failed == ["api went away"]
    done = await r.investigate("run_i", api.data["caseId"], "captured_order_failed", "REPLAY")
    assert done.status == "RESOLVED"
