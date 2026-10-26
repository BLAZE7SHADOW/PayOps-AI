from __future__ import annotations

from .base import CamelModel


class PerformanceMetrics(CamelModel):
    """Last-7-day performance. A null value means there was nothing to measure, which the UI shows as "No data", never as zero."""

    resolution_time_median_ms: int | None
    resolved_count: int
    #: 0 to 1.
    auto_resolution_rate: float | None
    #: 0 to 1, from operator ratings of diagnoses.
    agent_accuracy: float | None
    rated_count: int
    approval_turnaround_median_ms: int | None
    decided_approval_count: int
    cost_per_case_usd: float | None
    cases_with_runs: int
