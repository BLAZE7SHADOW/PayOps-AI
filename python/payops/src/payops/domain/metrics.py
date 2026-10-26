"""Pure metric math for the Overview "Performance" block (D079). Rows in, numbers out; the service only fetches rows."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from ..dto.metrics import PerformanceMetrics
from .timeutil import ms_between


@dataclass(frozen=True)
class ResolvedCaseRow:
    opened_at: datetime
    resolved_at: datetime
    resolved_by: str | None


@dataclass(frozen=True)
class DecidedApprovalRow:
    requested_at: datetime
    decided_at: datetime


@dataclass(frozen=True)
class FeedbackRow:
    verdict: str  # RIGHT | WRONG


@dataclass(frozen=True)
class RunCostRow:
    case_id: str
    cost_usd: float


def median(values: Sequence[float]) -> int | None:
    """The middle value, or for an even count the mean of the middle two rounded half up (as `Math.round` does)."""
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    if len(s) % 2:
        return int(s[mid])
    return math.floor((s[mid - 1] + s[mid]) / 2 + 0.5)


def compute_performance(
    resolved: Sequence[ResolvedCaseRow], approvals: Sequence[DecidedApprovalRow], feedback: Sequence[FeedbackRow], runs: Sequence[RunCostRow]
) -> PerformanceMetrics:
    rated = len(feedback)
    right = sum(1 for f in feedback if f.verdict == "RIGHT")
    cases_with_runs = len({r.case_id for r in runs})
    spend = sum(r.cost_usd for r in runs)
    return PerformanceMetrics(
        resolution_time_median_ms=median([ms_between(c.resolved_at, c.opened_at) for c in resolved]),
        resolved_count=len(resolved),
        auto_resolution_rate=(sum(1 for c in resolved if c.resolved_by == "AGENT") / len(resolved)) if resolved else None,
        agent_accuracy=(right / rated) if rated else None,
        rated_count=rated,
        approval_turnaround_median_ms=median([ms_between(a.decided_at, a.requested_at) for a in approvals]),
        decided_approval_count=len(approvals),
        cost_per_case_usd=(spend / cases_with_runs) if cases_with_runs else None,
        cases_with_runs=cases_with_runs,
    )
