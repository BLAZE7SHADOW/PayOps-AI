"""The eval baseline: what counts as a regression, what is only an improvement, and that the report is complete."""

from __future__ import annotations

import copy
import json
from typing import Any

from payops.evals.baseline import compare, dumps, make_baseline, make_report
from payops.evals.report import RunOutcome, summarize


def outcome(key: str = "refund_stuck", **over: Any) -> RunOutcome:
    base: dict[str, Any] = dict(
        key=key, scenario=key, ok=True, failures=[], status="RESOLVED", tier="AUTO", verdict="PASS", root_cause="X",
        expected_root_cause="X", root_cause_match=True, known_root_cause_caveat=None, action_types=["SYNC_REFUND_STATUS"],
        action_set_match=True, tools_used=["getRefund"], tool_set_match=True, attempt=1, replanned=False, tool_calls=10,
        llm_calls=2, jev_calls=3, cost_usd=0.001, latency_ms=12.0, grounding_violations=0, quarantine_ok=None,
        replay={"start": {"exact": 5, "fallback": 0}},
    )  # fmt: skip
    return RunOutcome(**{**base, **over})


def baseline_of(*outcomes: RunOutcome) -> dict[str, Any]:
    return make_baseline(list(outcomes), summarize(list(outcomes)))


def regressions(old: list[RunOutcome], new: list[RunOutcome]) -> list[str]:
    return compare(baseline_of(*old), baseline_of(*new)).regressions


def test_an_identical_run_has_no_regressions_and_no_improvements() -> None:
    result = compare(baseline_of(outcome()), baseline_of(outcome()))
    assert result.regressions == [] and result.improvements == []


def test_the_baseline_is_stable_and_ordered_so_its_diffs_are_readable() -> None:
    a, b = outcome("b_case"), outcome("a_case")
    first = dumps(baseline_of(a, b))
    assert first == dumps(baseline_of(b, a))
    assert list(json.loads(first)["scenarios"]) == ["a_case", "b_case"]


def test_each_kind_of_worse_result_is_named() -> None:
    old = [outcome()]
    cases = {
        "passed in the baseline and now fails": outcome(ok=False, failures=["x"]),
        "status changed from RESOLVED to ESCALATED": outcome(status="ESCALATED"),
        "policy tier changed from AUTO to MANAGER": outcome(tier="MANAGER"),
        "verdict changed from PASS to FAIL": outcome(verdict="FAIL"),
        "proposed actions changed": outcome(action_types=["MARK_ORDER_PAID"]),
        "root cause no longer matches": outcome(root_cause_match=False, root_cause="Y"),
        "tool calls rose from 10 to 11": outcome(tool_calls=11),
        "model calls rose from 2 to 3": outcome(llm_calls=3),
        "Jev calls rose from 3 to 4": outcome(jev_calls=4),
        "cost rose": outcome(cost_usd=0.002),
        "grounding violations rose from 0 to 1": outcome(grounding_violations=1),
        "fallback lookups rose from 0 to 1": outcome(replay={"start": {"exact": 5, "fallback": 1}}),
    }
    for expected, new in cases.items():
        found = regressions(old, [new])
        assert any(expected in r for r in found), (expected, found)


def test_a_scenario_that_disappears_is_a_regression_but_a_new_one_is_not() -> None:
    assert any("no longer run" in r for r in regressions([outcome("a"), outcome("b")], [outcome("a")]))
    result = compare(baseline_of(outcome("a")), baseline_of(outcome("a"), outcome("b")))
    assert result.regressions == [] and any("new scenario" in i for i in result.improvements)


def test_a_better_run_never_fails_but_is_reported() -> None:
    result = compare(baseline_of(outcome()), baseline_of(outcome(tool_calls=7, cost_usd=0.0005, llm_calls=1)))
    assert result.regressions == []
    assert any("tool calls fell from 10 to 7" in i for i in result.improvements)
    assert any("cost" in i for i in result.improvements)


def test_summary_rates_that_fall_are_regressions() -> None:
    old = baseline_of(outcome("a"), outcome("b"))
    worse = baseline_of(outcome("a"), outcome("b", root_cause_match=False, ok=True))
    found = compare(old, worse).regressions
    assert any("root-cause accuracy fell" in r for r in found)


def test_the_report_holds_every_scenario_with_its_failures_and_replay_detail() -> None:
    outcomes = [outcome("a"), outcome("b", ok=False, failures=["status: expected X"])]
    summary = summarize(outcomes)
    comparison = compare(make_baseline(outcomes, summary), copy.deepcopy(make_baseline(outcomes, summary)))
    report = make_report(outcomes, summary, comparison, commit="abc123")
    assert report["commit"] == "abc123" and report["aiMode"] == "REPLAY"
    assert set(report["scenarios"]) == {"a", "b"}
    assert report["scenarios"]["b"]["failures"] == ["status: expected X"]
    assert report["scenarios"]["a"]["replay"] == {"start": {"exact": 5, "fallback": 0}}
    assert report["regressions"] == [] and report["summary"]["total"] == 2
    json.dumps(report)  # serialisable as is
