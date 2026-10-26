# pyright: reportArgumentType=false, reportCallIssue=false
"""The 18 golden scenarios, in process, in REPLAY: every hard gate passes, the aggregate limits hold, and every recorded model response is found by its exact
key (a fallback would mean a prompt or request changed since it was recorded). This is the same gate `pnpm eval:python` held for the two-service setup."""

from __future__ import annotations

from payops.container import build_services
from payops.db.engine import create_engine, session_factory
from payops.evals.baseline import compare, load_baseline, make_baseline
from payops.evals.golden import GOLDEN_SCENARIOS
from payops.evals.report import check_thresholds, summarize
from payops.evals.runner import run_eval_suite
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_simulator_parity import NOW


async def test_every_golden_scenario_passes_its_gates(database_url: str) -> None:
    engine = create_engine(url=database_url, pool_size=5)
    try:
        services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
        outcomes = await run_eval_suite(services)
    finally:
        await engine.dispose()
    assert len(outcomes) == len(GOLDEN_SCENARIOS) == 18
    assert [(o.key, o.failures) for o in outcomes if not o.ok] == []
    summary = summarize(outcomes)
    assert check_thresholds(summary) == []
    assert (summary.exact_lookups, summary.fallback_lookups) == (83, 0)
    assert summary.root_cause_accuracy == 1.0
    # The committed baseline (fixtures/evals/baseline.json) is what this run is held to: nothing may be worse than it.
    baseline = load_baseline()
    assert baseline is not None, (
        "run `uv run python -m payops.evals --update-baseline` and commit fixtures/evals/baseline.json"
    )
    assert compare(baseline, make_baseline(outcomes, summary)).regressions == []
