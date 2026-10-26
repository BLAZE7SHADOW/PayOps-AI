"""Read side of resolutions: builds ResolutionItem DTOs (with approval, execution steps and the latest validation) and the case page's
resolution view. Batched: a constant number of queries however many resolutions are shown. (packages/core resolution-query.service.ts)"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from pydantic import TypeAdapter
from sqlalchemy import and_, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Approval, Case, Execution, Resolution, ValidationResult
from ..domain.actions.idempotency import idempotency_key
from ..domain.actions.options import AttemptHistory, action_options
from ..domain.gateway import PaymentGateway
from ..domain.permissions import has_permission
from ..domain.timeutil import to_iso
from ..dto.actions import CatalogAction
from ..dto.resolution import ApprovalSummary, CaseResolutionView, ExecutionStep, ResolutionItem, ValidationResultDto
from ..errors import not_found
from ..infra.snapshots import load_case_state
from ..ports import Clock
from .cases import CLOSED_CASE_STATUSES

if TYPE_CHECKING:
    from ..api.security import SessionUser

_ACTION: TypeAdapter[CatalogAction] = TypeAdapter(CatalogAction)


def to_approval_summary(a: Approval) -> ApprovalSummary:
    return ApprovalSummary.model_validate(
        {
            "id": a.id,
            "tier": a.tier,
            "status": a.status,
            "decidedBy": a.decided_by,
            "comment": a.comment,
            "decidedAt": to_iso(a.decided_at) if a.decided_at else None,
        }
    )


def to_validation_dto(v: ValidationResult) -> ValidationResultDto:
    return ValidationResultDto.model_validate({"id": v.id, "verdict": v.verdict, "checks": v.checks, "at": to_iso(v.at)})


def to_execution_steps(resolution: Resolution, rows: Sequence[Execution]) -> list[ExecutionStep]:
    """Persisted steps, plus SKIPPED placeholders for actions after a failed step."""
    by_index = {r.action_index: r for r in rows}
    steps: list[ExecutionStep] = []
    failed_at: str | None = None
    for index, action in enumerate(resolution.actions):
        row = by_index.get(index)
        if row is not None:
            steps.append(
                ExecutionStep(
                    index=index,
                    type=action["type"],
                    status=row.status,
                    idempotency_key=row.idempotency_key,
                    summary=row.summary,
                    error=row.error,
                    before=row.before,
                    started_at=to_iso(row.started_at),
                    finished_at=to_iso(row.finished_at) if row.finished_at else None,
                )
            )
            if row.status == "FAILED":
                failed_at = to_iso(row.finished_at or row.started_at)
        elif failed_at is not None:
            steps.append(
                ExecutionStep(
                    index=index,
                    type=action["type"],
                    status="SKIPPED",
                    idempotency_key=idempotency_key(resolution.id, index, _ACTION.validate_python(action)),
                    summary="Skipped because an earlier step failed",
                    error=None,
                    before=None,
                    started_at=failed_at,
                    finished_at=None,
                )
            )
    return steps


class ResolutionQueryService:
    def __init__(self, clock: Clock, gateway: PaymentGateway) -> None:
        self._clock = clock
        self._gateway = gateway

    async def row(self, session: AsyncSession, resolution_id: str) -> Resolution:
        row = await session.get(Resolution, resolution_id)
        if row is None:
            raise not_found("Resolution", resolution_id)
        return row

    async def item(self, session: AsyncSession, resolution_id: str) -> ResolutionItem:
        return (await self.to_items(session, [await self.row(session, resolution_id)]))[0]

    async def to_items(self, session: AsyncSession, rows: Sequence[Resolution]) -> list[ResolutionItem]:
        if not rows:
            return []
        ids = [r.id for r in rows]
        approvals = (await session.scalars(select(Approval).where(Approval.resolution_id.in_(ids)))).all()
        executions = (await session.scalars(select(Execution).where(Execution.resolution_id.in_(ids)))).all()
        validations = (await session.scalars(select(ValidationResult).where(ValidationResult.resolution_id.in_(ids)).order_by(desc(ValidationResult.at)))).all()
        approval_by = {a.resolution_id: a for a in approvals}
        latest_validation: dict[str, ValidationResult] = {}
        for v in validations:
            latest_validation.setdefault(v.resolution_id, v)
        items: list[ResolutionItem] = []
        for r in rows:
            approval, validation = approval_by.get(r.id), latest_validation.get(r.id)
            items.append(
                ResolutionItem(
                    id=r.id,
                    case_id=r.case_id,
                    run_id=r.run_id,
                    attempt=r.attempt,
                    status=r.status,
                    actions=r.actions,
                    rationale=r.rationale,
                    proposed_by=r.proposed_by,
                    policy=r.policy,
                    approval=to_approval_summary(approval) if approval else None,
                    executions=to_execution_steps(r, [e for e in executions if e.resolution_id == r.id]),
                    validation=to_validation_dto(validation) if validation else None,
                    created_at=to_iso(r.created_at),
                    updated_at=to_iso(r.updated_at),
                )
            )
        return items

    async def rows_for_case(self, session: AsyncSession, case_id: str) -> list[Resolution]:
        """Newest first."""
        return list(
            (
                await session.scalars(select(Resolution).where(Resolution.case_id == case_id).order_by(desc(Resolution.created_at), desc(Resolution.attempt)))
            ).all()
        )

    async def pending_approval(self, session: AsyncSession, case_id: str) -> Approval | None:
        return (await session.scalars(select(Approval).where(and_(Approval.case_id == case_id, Approval.status == "PENDING")).limit(1))).first()

    @staticmethod
    def history(items: Sequence[ResolutionItem]) -> list[AttemptHistory]:
        return [AttemptHistory([a["type"] for a in i.actions], i.status, i.validation.verdict if i.validation else None) for i in items]

    @staticmethod
    def cannot_propose_reason(case: Case, items: Sequence[ResolutionItem], pending: Approval | None, viewer: SessionUser | None) -> str | None:
        """Why the viewer cannot propose now, or None if they can."""
        if viewer is None:
            return "Sign in to propose a resolution."
        if not has_permission(viewer.role, "resolution.propose"):
            return f"Your role ({viewer.role}) can view cases but not propose resolutions."
        if case.status in CLOSED_CASE_STATUSES:
            return f"This case is {case.status}."
        if pending is not None:
            return "A proposed resolution is waiting for approval."
        if any(i.status == "EXECUTING" for i in items):
            return "A resolution is executing."
        return None

    async def view(self, session: AsyncSession, case: Case, viewer: SessionUser | None) -> CaseResolutionView:
        state = await load_case_state(session, self._gateway, case, self._clock.now())
        items = await self.to_items(session, await self.rows_for_case(session, case.id))
        pending = await self.pending_approval(session, case.id)
        reason = self.cannot_propose_reason(case, items, pending, viewer)
        return CaseResolutionView(
            action_options=action_options(state, self.history(items)),
            resolutions=items,
            pending_approval_id=pending.id if pending else None,
            can_propose=reason is None,
            cannot_propose_reason=reason,
        )
