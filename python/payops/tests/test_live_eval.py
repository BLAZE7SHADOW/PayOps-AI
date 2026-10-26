"""The live eval's plumbing, with no provider calls: which scenarios it runs, the cost cap, and the failure report. Real LIVE runs need keys and
make billed calls, so they are never run from tests."""

from __future__ import annotations

from payops.container import build_services
from payops.db.engine import create_engine, session_factory
from payops.evals.golden import GOLDEN_SCENARIOS
from payops.evals.live import live_goldens, problems_for
from payops.evals.runner import run_eval_suite
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_simulator_parity import NOW


def test_live_runs_only_the_scenarios_whose_answers_come_from_the_providers() -> None:
    chosen = live_goldens()
    assert chosen and all(g.fixture is None for g in chosen)
    assert len(chosen) < len(GOLDEN_SCENARIOS)  # the fixture scenarios never call a model


def test_only_filters_by_scenario_or_key() -> None:
    assert {g.scenario for g in live_goldens({"refund_stuck"})} == {"refund_stuck"}
    assert live_goldens({"no_such_scenario"}) == ()


async def test_the_cost_cap_stops_the_suite_before_the_next_scenario(database_url: str) -> None:
    goldens = live_goldens({"captured_order_failed", "refund_stuck"})
    assert len(goldens) == 2
    engine = create_engine(url=database_url, pool_size=5)
    try:
        services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
        outcomes = await run_eval_suite(services, goldens, max_cost_usd=0.0)  # REPLAY still reports the recorded cost
    finally:
        await engine.dispose()
    assert len(outcomes) == 1
    assert problems_for(outcomes, expected=2) == ["stopped at the cost cap after 1 of 2 scenarios"]


def test_failed_gates_and_limits_are_named() -> None:
    from tests.test_eval_baseline import outcome

    bad = outcome(
        "refund_stuck", ok=False, failures=["status: expected RESOLVED, got ESCALATED"], root_cause_match=False
    )
    problems = problems_for([bad], expected=1)
    assert "scenario refund_stuck failed its gates" in problems
    assert any("root-cause accuracy" in p for p in problems)
