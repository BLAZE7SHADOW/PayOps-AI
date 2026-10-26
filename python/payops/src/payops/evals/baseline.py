"""The eval report written for every run, and the committed baseline a run is compared with.

The aggregate limits in `report.py` catch a slow slide. The baseline catches everything else: it records what each golden scenario did
the last time the result was accepted, so a change in outcome, actions, tool use, cost or replay quality shows up as a named regression
even when no fixed limit is crossed. Replay is deterministic, so any difference is real. A deliberate change is accepted by rewriting the
baseline (`--update-baseline`) and reading the diff in review.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .report import RunOutcome, Summary, check_thresholds

VERSION = 1
#: `fixtures/evals/baseline.json` at the repository root.
BASELINE_PATH = Path(__file__).resolve().parents[5] / "fixtures" / "evals" / "baseline.json"
#: Cost differences below this are rounding, not a change.
COST_EPSILON = 1e-6


def _r(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(value, digits)


def summary_dict(s: Summary) -> dict[str, Any]:
    return {
        "total": s.total,
        "passed": s.passed,
        "rootCauseAccuracy": _r(s.root_cause_accuracy),
        "actionSetMatchRate": _r(s.action_set_match_rate),
        "toolSetMatchRate": _r(s.tool_set_match_rate),
        "replanSuccessRate": _r(s.replan_success_rate),
        "meanToolCalls": _r(s.mean_tool_calls, 3),
        "totalCostUsd": _r(s.total_cost_usd),
        "exactLookups": s.exact_lookups,
        "fallbackLookups": s.fallback_lookups,
    }


def scenario_dict(o: RunOutcome) -> dict[str, Any]:
    """What the baseline pins for one scenario: the outcome and the cost of reaching it, nothing that varies between runs."""
    return {
        "scenario": o.scenario,
        "ok": o.ok,
        "status": o.status,
        "tier": o.tier,
        "verdict": o.verdict,
        "rootCause": o.root_cause,
        "rootCauseMatch": o.root_cause_match,
        "actionTypes": o.action_types,
        "toolCalls": o.tool_calls,
        "llmCalls": o.llm_calls,
        "jevCalls": o.jev_calls,
        "costUsd": _r(o.cost_usd),
        "groundingViolations": o.grounding_violations,
        "replayFallback": sum(v["fallback"] for v in o.replay.values()),
    }


def make_baseline(outcomes: list[RunOutcome], summary: Summary) -> dict[str, Any]:
    return {
        "version": VERSION,
        "summary": summary_dict(summary),
        "scenarios": {o.key: scenario_dict(o) for o in sorted(outcomes, key=lambda o: o.key)},
    }


def make_report(
    outcomes: list[RunOutcome], summary: Summary, comparison: Comparison | None, *, commit: str | None
) -> dict[str, Any]:
    """The full record of one run, for CI to keep and for comparing runs over time."""
    return {
        "version": VERSION,
        "commit": commit,
        "aiMode": "REPLAY",
        "summary": summary_dict(summary),
        "thresholds": check_thresholds(summary),
        "regressions": comparison.regressions if comparison else None,
        "improvements": comparison.improvements if comparison else None,
        "scenarios": {
            o.key: {
                **scenario_dict(o),
                "failures": o.failures,
                "toolsUsed": o.tools_used,
                "expectedRootCause": o.expected_root_cause,
                "knownRootCauseCaveat": o.known_root_cause_caveat,
                "attempt": o.attempt,
                "replanned": o.replanned,
                "replay": o.replay,
                # Replay latency is not a measurement, so it is recorded for reference only and never compared.
                "latencyMs": round(o.latency_ms),
            }
            for o in sorted(outcomes, key=lambda o: o.key)
        },
    }


def dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def load_baseline(path: Path = BASELINE_PATH) -> dict[str, Any] | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


@dataclass
class Comparison:
    #: Things that got worse or changed behaviour. Any entry fails the run.
    regressions: list[str] = field(default_factory=list)
    #: Things that got better or are new. They never fail a run, but they mean the baseline can be updated.
    improvements: list[str] = field(default_factory=list)


#: Summary rates where lower is worse, with the name used in messages.
_HIGHER_IS_BETTER = (
    ("rootCauseAccuracy", "root-cause accuracy"),
    ("actionSetMatchRate", "action-set match"),
    ("toolSetMatchRate", "tool-set match"),
    ("replanSuccessRate", "replan success"),
    ("exactLookups", "exact replay lookups"),
    ("passed", "scenarios passing"),
)


def compare(baseline: dict[str, Any], current: dict[str, Any]) -> Comparison:
    """`current` is `make_baseline` output for this run. Pure: no files, no clocks."""
    out = Comparison()
    same_scenarios = baseline["scenarios"].keys() == current["scenarios"].keys()
    if not same_scenarios:
        # Totals depend on how many scenarios ran, so they are only comparable when the set is the same.
        out.improvements.append("the set of scenarios changed: totals are not compared until the baseline is updated")
    for key, label in _HIGHER_IS_BETTER if same_scenarios else ():
        old, new = baseline["summary"].get(key), current["summary"].get(key)
        if old is None or new is None:
            continue
        if new < old:
            out.regressions.append(f"{label} fell from {old} to {new}")
        elif new > old:
            out.improvements.append(f"{label} rose from {old} to {new}")
    for key, label in (
        (("fallbackLookups", "replay lookups by fallback"), ("totalCostUsd", "total cost (USD)"))
        if same_scenarios
        else ()
    ):
        old, new = baseline["summary"][key], current["summary"][key]
        if new > old + COST_EPSILON:
            out.regressions.append(f"{label} rose from {old} to {new}")
        elif new < old - COST_EPSILON:
            out.improvements.append(f"{label} fell from {old} to {new}")

    old_s, new_s = baseline["scenarios"], current["scenarios"]
    for key in sorted(old_s.keys() - new_s.keys()):
        out.regressions.append(f"{key}: scenario is no longer run")
    for key in sorted(new_s.keys() - old_s.keys()):
        out.improvements.append(f"{key}: new scenario, not in the baseline yet")
    for key in sorted(old_s.keys() & new_s.keys()):
        old, new = old_s[key], new_s[key]
        if old["ok"] and not new["ok"]:
            out.regressions.append(f"{key}: passed in the baseline and now fails")
        for field_name, label in (
            ("status", "status"),
            ("tier", "policy tier"),
            ("verdict", "verdict"),
            ("actionTypes", "proposed actions"),
        ):
            if old[field_name] != new[field_name]:
                out.regressions.append(f"{key}: {label} changed from {old[field_name]} to {new[field_name]}")
        if old["rootCauseMatch"] and not new["rootCauseMatch"]:
            out.regressions.append(f"{key}: root cause no longer matches ({old['rootCause']} -> {new['rootCause']})")
        elif not old["rootCauseMatch"] and new["rootCauseMatch"]:
            out.improvements.append(f"{key}: root cause now matches")
        for field_name, label in (
            ("toolCalls", "tool calls"),
            ("llmCalls", "model calls"),
            ("jevCalls", "Jev calls"),
            ("replayFallback", "fallback lookups"),
        ):
            if new[field_name] > old[field_name]:
                out.regressions.append(f"{key}: {label} rose from {old[field_name]} to {new[field_name]}")
            elif new[field_name] < old[field_name]:
                out.improvements.append(f"{key}: {label} fell from {old[field_name]} to {new[field_name]}")
        if new["costUsd"] > old["costUsd"] + COST_EPSILON:
            out.regressions.append(f"{key}: cost rose from {old['costUsd']} to {new['costUsd']}")
        old_g, new_g = old["groundingViolations"], new["groundingViolations"]
        if old_g is not None and new_g is not None and new_g > old_g:
            out.regressions.append(f"{key}: grounding violations rose from {old_g} to {new_g}")
    return out
