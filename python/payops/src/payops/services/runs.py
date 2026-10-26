"""Agent run reads: the run list and detail, the step timeline a reconnecting client rebuilds from, and operator feedback on diagnoses.
(apps/server runs.ts, packages/core feedback.service.ts)"""

from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AgentRun, AgentStep, DiagnosisFeedback
from ..domain.timeutil import to_iso
from ..dto.api import Page
from ..dto.runs import AgentRunItem, AgentStepItem, DiagnosisFeedbackItem, RunListQuery, RunValidation
from ..errors import not_found
from .resolutions import ResolutionQueryService


class RunQueryService:
    def __init__(self, resolutions: ResolutionQueryService) -> None:
        self._resolutions = resolutions

    async def _to_item(self, session: AsyncSession, row: AgentRun) -> AgentRunItem:
        executions, validation, policy = [], None, row.policy
        if row.resolution_id:
            # The resolution is the source of truth once it exists; the run's own snapshot is only the fallback.
            item = await self._resolutions.item(session, row.resolution_id)
            executions = item.executions
            validation = RunValidation(verdict=item.validation.verdict, checks=item.validation.checks) if item.validation else None
            policy = item.policy
        return AgentRunItem(
            id=row.id,
            case_id=row.case_id,
            resolution_id=row.resolution_id,
            status=row.status,
            path=row.path,
            attempt=row.attempt,
            budget=row.budget,
            diagnosis=row.diagnosis,
            proposal=row.proposal,
            policy=policy,
            approval_id=row.approval_id,
            error=row.error,
            executions=executions,
            validation=validation,
            findings=row.findings,
            evidence=row.evidence,
            grounding=row.grounding,
            created_at=to_iso(row.created_at),
            updated_at=to_iso(row.updated_at),
            finished_at=to_iso(row.finished_at) if row.finished_at else None,
        )

    async def list(self, session: AsyncSession, query: RunListQuery) -> Page[AgentRunItem]:
        stmt = select(AgentRun)
        if query.case_id:
            stmt = stmt.where(AgentRun.case_id == query.case_id)
        if query.status:
            stmt = stmt.where(AgentRun.status == query.status)
        rows = (await session.scalars(stmt.order_by(desc(AgentRun.created_at)).limit(query.limit))).all()
        items = [await self._to_item(session, r) for r in rows]
        return Page[AgentRunItem](items=items, next_cursor=None, total=len(items))

    async def get(self, session: AsyncSession, run_id: str) -> AgentRunItem:
        row = await session.get(AgentRun, run_id)
        if row is None:
            raise not_found("Run", run_id)
        return await self._to_item(session, row)

    async def steps(self, session: AsyncSession, run_id: str) -> Page[AgentStepItem]:
        rows = (await session.scalars(select(AgentStep).where(AgentStep.run_id == run_id).order_by(AgentStep.seq))).all()
        items = [AgentStepItem(id=r.id, run_id=r.run_id, seq=r.seq, node=r.node, kind=r.kind, payload=r.payload, at=to_iso(r.at)) for r in rows]
        return Page[AgentStepItem](items=items, next_cursor=None, total=len(items))

    async def feedback(self, session: AsyncSession, run_id: str) -> Page[DiagnosisFeedbackItem]:
        rows = (await session.scalars(select(DiagnosisFeedback).where(DiagnosisFeedback.run_id == run_id).order_by(desc(DiagnosisFeedback.updated_at)))).all()
        items = [
            DiagnosisFeedbackItem(
                id=r.id,
                run_id=r.run_id,
                case_id=r.case_id,
                diagnosed_root_cause=r.diagnosed_root_cause,
                verdict=r.verdict,
                reason=r.reason,
                correct_root_cause=r.correct_root_cause,
                given_by_id=r.given_by_id,
                given_by_name=r.given_by_name,
                created_at=to_iso(r.created_at),
                updated_at=to_iso(r.updated_at),
            )
            for r in rows
        ]
        return Page[DiagnosisFeedbackItem](items=items, next_cursor=None, total=len(items))
