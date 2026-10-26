"""Case writes. (More of packages/core case.service.ts arrives with the sweep and signal intake; this is the status change the executor and the
resolution flow use.)"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Case
from ...errors import not_found
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from
from ..cases import CLOSED_CASE_STATUSES

#: Audit action names for case status changes.
CASE_STATUS_ACTION = {
    "OPEN": "case.reopened",
    "INVESTIGATING": "case.investigating",
    "AWAITING_APPROVAL": "case.awaiting_approval",
    "EXECUTING": "case.executing",
    "RESOLVED": "case.resolved",
    "ESCALATED": "case.escalated",
    "REJECTED": "case.rejected",
}

_UNSET: Any = object()


class CaseWriteService:
    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def set_status(
        self, session: AsyncSession, case_id: str, status: str, summary: str, ctx: WriteContext, *, resolution: dict[str, Any] | None = _UNSET
    ) -> Case:
        """Moves a case to a new status and audits it when the status actually changed. Used by the resolution flow (AWAITING_APPROVAL, EXECUTING,
        RESOLVED...) and the ESCALATE action."""
        row = (await session.scalars(select(Case).where(Case.id == case_id).with_for_update().execution_options(populate_existing=True))).one_or_none()
        if row is None:
            raise not_found("Case", case_id)
        previous = row.status
        now = self._clock.now()
        closing = status in CLOSED_CASE_STATUSES
        row.status = status
        row.updated_at = now
        row.resolved_at = now if status == "RESOLVED" else (row.resolved_at if closing else None)
        if resolution is not _UNSET:
            row.resolution = resolution
        await session.flush()
        if previous != status:
            after: dict[str, Any] = {"status": status}
            if resolution is not _UNSET and resolution:
                after["resolution"] = resolution
            await self._audit.record(
                session,
                audit_from(
                    WriteContext(ctx.actor, case_id, ctx.run_id), action=CASE_STATUS_ACTION[status], entity_type="case", entity_id=case_id, summary=summary,
                    before={"status": previous}, after=after,
                ),
            )
        return row
