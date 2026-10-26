"""What an eval run measured, and the limits that fail it. Per-scenario hard gates already fail a run; the aggregate
limits catch a slow slide no single scenario trips, such as accuracy drifting down or cost creeping up. Latency is not
limited because REPLAY latency is not a real measurement."""

from __future__ import annotations

from dataclasses import dataclass, field

MIN_ROOT_CAUSE_ACCURACY = 0.8
MIN_ACTION_SET_MATCH_RATE = 0.8
MIN_TOOL_SET_MATCH_RATE = 0.8
MAX_TOTAL_COST_USD = 0.1


@dataclass
class RunOutcome:
    key: str
    scenario: str
    ok: bool
    failures: list[str]
    status: str
    tier: str | None
    verdict: str | None
    root_cause: str | None
    expected_root_cause: str
    root_cause_match: bool
    known_root_cause_caveat: str | None
    action_types: list[str]
    #: None when the golden scenario declares no allowed action sets.
    action_set_match: bool | None
    tools_used: list[str]
    #: Every expected tool was used; None when the golden scenario declares none. Soft.
    tool_set_match: bool | None
    attempt: int
    replanned: bool
    tool_calls: int
    llm_calls: int
    jev_calls: int
    cost_usd: float
    latency_ms: float
    #: None when groundCheck never ran (fast path).
    grounding_violations: int | None
    quarantine_ok: bool | None
    replay: dict[str, dict[str, int]] = field(default_factory=dict)


@dataclass
class Summary:
    total: int
    passed: int
    failed: int
    root_cause_accuracy: float
    action_set_match_rate: float | None
    replan_success_rate: float | None
    tool_set_match_rate: float | None
    mean_tool_calls: float
    total_cost_usd: float
    exact_lookups: int
    fallback_lookups: int


def _rate(items: list[bool]) -> float | None:
    return sum(items) / len(items) if items else None


def summarize(outcomes: list[RunOutcome]) -> Summary:
    scored = [o for o in outcomes if not o.known_root_cause_caveat]
    replanned = [o for o in outcomes if o.replanned]
    total = len(outcomes)
    lookups = [v for o in outcomes for v in o.replay.values()]
    return Summary(
        total=total,
        passed=sum(o.ok for o in outcomes),
        failed=sum(not o.ok for o in outcomes),
        root_cause_accuracy=(sum(o.root_cause_match for o in scored) / len(scored)) if scored else 1.0,
        action_set_match_rate=_rate([bool(o.action_set_match) for o in outcomes if o.action_set_match is not None]),
        replan_success_rate=_rate([o.status == "RESOLVED" for o in replanned]),
        tool_set_match_rate=_rate([bool(o.tool_set_match) for o in outcomes if o.tool_set_match is not None]),
        mean_tool_calls=sum(o.tool_calls for o in outcomes) / total if total else 0,
        total_cost_usd=sum(o.cost_usd for o in outcomes),
        exact_lookups=sum(v["exact"] for v in lookups),
        fallback_lookups=sum(v["fallback"] for v in lookups),
    )


def check_thresholds(s: Summary) -> list[str]:
    """One plain message per aggregate that crosses its limit. Empty means the run is healthy. A rate with nothing to
    measure is skipped, never failed."""
    out: list[str] = []
    if s.root_cause_accuracy < MIN_ROOT_CAUSE_ACCURACY:
        out.append(
            f"root-cause accuracy {s.root_cause_accuracy:.1%} is below the {MIN_ROOT_CAUSE_ACCURACY:.1%} minimum"
        )
    if s.action_set_match_rate is not None and s.action_set_match_rate < MIN_ACTION_SET_MATCH_RATE:
        out.append(
            f"action-set match {s.action_set_match_rate:.1%} is below the {MIN_ACTION_SET_MATCH_RATE:.1%} minimum"
        )
    if s.tool_set_match_rate is not None and s.tool_set_match_rate < MIN_TOOL_SET_MATCH_RATE:
        out.append(f"tool-set match {s.tool_set_match_rate:.1%} is below the {MIN_TOOL_SET_MATCH_RATE:.1%} minimum")
    if s.total_cost_usd > MAX_TOTAL_COST_USD:
        out.append(f"total cost ${s.total_cost_usd:.4f} is above the ${MAX_TOTAL_COST_USD:.2f} cap")
    return out


def render(outcomes: list[RunOutcome], summary: Summary) -> str:
    lines = [
        f"{'PASS' if o.ok else 'FAIL'}  {o.key:36} status={o.status} tier={o.tier or '-'} verdict={o.verdict or '-'} rootCause={o.root_cause or '-'}"
        for o in outcomes
    ]
    for o in outcomes:
        lines.extend(f"       - {f}" for f in o.failures)
    lines.append("")
    lines.append(
        f"{summary.passed}/{summary.total} scenarios pass. root-cause accuracy {summary.root_cause_accuracy:.1%}, mean tool calls {summary.mean_tool_calls:.1f}"
    )
    lines.append(f"Replay lookups: {summary.exact_lookups} exact, {summary.fallback_lookups} by fallback")
    lines.extend(f"THRESHOLD: {m}" for m in check_thresholds(summary))
    return "\n".join(lines)
