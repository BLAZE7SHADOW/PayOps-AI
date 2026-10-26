"""Overview metrics: counts, the 14-day exceptions trend, the oldest open cases and the last-7-day performance block.
(packages/core overview.service.ts)"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import asc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AgentRun, Approval, Case, DiagnosisFeedback, User, ValidationResult
from ..domain.enums import CASE_TYPES, OPEN_CASE_STATUSES
from ..domain.gateway import PaymentGateway
from ..domain.metrics import DecidedApprovalRow, FeedbackRow, ResolvedCaseRow, RunCostRow, compute_performance
from ..domain.timeutil import DAY_MS
from ..dto.api import OverviewMetrics
from ..ports import Clock
from .cases import to_case_list_item

TREND_DAYS = 14
_DAY = timedelta(milliseconds=DAY_MS)


def start_of_utc_day(d: datetime) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


class OverviewService:
    def __init__(self, clock: Clock, gateway: PaymentGateway) -> None:
        self._clock = clock
        self._gateway = gateway

    async def metrics(self, session: AsyncSession) -> OverviewMetrics:
        now = self._clock.now()
        today = start_of_utc_day(now)
        since7d = now - 7 * _DAY
        trend_start = today - (TREND_DAYS - 1) * _DAY
        day = func.to_char(func.timezone("UTC", Case.opened_at), "YYYY-MM-DD")

        captured = await self._gateway.summarize_captures(today, today + _DAY)
        open_rows = (
            await session.execute(
                select(Case.status, func.count()).where(Case.status.in_(OPEN_CASE_STATUSES)).group_by(Case.status)
            )
        ).all()
        resolved_count = (
            await session.execute(
                select(func.count())
                .select_from(Case)
                .where(Case.status == "RESOLVED", Case.resolved_at >= now - 7 * _DAY)
            )
        ).scalar_one()
        trend_rows = (
            await session.execute(
                select(day, Case.type, func.count()).where(Case.opened_at >= trend_start).group_by(day, Case.type)
            )
        ).all()
        oldest = (
            await session.execute(
                select(Case, User.name)
                .join(User, User.id == Case.assignee_id, isouter=True)
                .where(Case.status.in_(OPEN_CASE_STATUSES))
                .order_by(asc(Case.opened_at), asc(Case.id))
                .limit(5)
            )
        ).all()
        pending = (
            await session.execute(select(func.count()).select_from(Approval).where(Approval.status == "PENDING"))
        ).scalar_one()
        agent_resolved = (
            await session.execute(
                select(func.count())
                .select_from(Case)
                .where(
                    Case.status == "RESOLVED",
                    Case.resolved_at >= now - 7 * _DAY,
                    Case.resolution["by"].astext == "AGENT",
                )
            )
        ).scalar_one()
        verdict_rows = (
            await session.execute(
                select(ValidationResult.verdict, func.count())
                .where(ValidationResult.at >= now - 7 * _DAY)
                .group_by(ValidationResult.verdict)
            )
        ).all()
        perf_cases = (
            await session.execute(
                select(Case.opened_at, Case.resolved_at, Case.resolution).where(
                    Case.status == "RESOLVED", Case.resolved_at.is_not(None), Case.resolved_at >= since7d
                )
            )
        ).all()
        perf_approvals = (
            await session.execute(
                select(Approval.requested_at, Approval.decided_at).where(
                    Approval.decided_at.is_not(None), Approval.decided_at >= since7d
                )
            )
        ).all()
        perf_feedback = (
            await session.execute(select(DiagnosisFeedback.verdict).where(DiagnosisFeedback.updated_at >= since7d))
        ).all()
        perf_runs = (
            await session.execute(select(AgentRun.case_id, AgentRun.budget).where(AgentRun.created_at >= since7d))
        ).all()

        performance = compute_performance(
            [ResolvedCaseRow(o, r, (res or {}).get("by")) for o, r, res in perf_cases if r is not None],
            [DecidedApprovalRow(req, dec) for req, dec in perf_approvals if dec is not None],
            [FeedbackRow(v) for (v,) in perf_feedback],
            [RunCostRow(case_id, budget["costUsd"]) for case_id, budget in perf_runs],
        )
        verdicts = {"PASS": 0, "PARTIAL": 0, "FAIL": 0}
        for verdict, n in verdict_rows:
            verdicts[verdict] = n

        by_day: dict[str, dict[str, Any]] = {}
        for i in range(TREND_DAYS):
            by_day[(trend_start + i * _DAY).strftime("%Y-%m-%d")] = {}
        for d, case_type, n in trend_rows:
            bucket = by_day.get(d)
            if bucket is not None and case_type in CASE_TYPES:
                bucket[case_type] = n

        return OverviewMetrics(
            captured_today_minor=captured.amount_minor,
            captured_today_count=captured.count,
            open_exceptions=sum(n for _, n in open_rows),
            awaiting_approval=pending,
            resolved7d=resolved_count,
            resolvedByAgent7d=agent_resolved,
            validatorOutcomes7d=verdicts,
            exceptions_by_type=[{"date": d, **counts} for d, counts in by_day.items()],
            oldest_open=[to_case_list_item(c, name, now) for c, name in oldest],
            performance=performance,
        )
