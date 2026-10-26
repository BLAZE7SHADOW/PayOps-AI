"""Settlement disputes raised against the acquirer. (packages/core dispute.service.ts)"""

from __future__ import annotations

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Dispute
from ...domain.ids import new_id
from ...domain.money import format_money
from ...errors import AppError
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from


class DisputeWriteService:
    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def open_for_batch(self, session: AsyncSession, batch_id: str) -> Dispute | None:
        return (
            await session.scalars(
                select(Dispute).where(and_(Dispute.batch_id == batch_id, Dispute.status == "OPEN")).limit(1)
            )
        ).first()

    async def raise_settlement(
        self,
        session: AsyncSession,
        *,
        batch_id: str,
        gw_payment_id: str | None,
        amount_minor: int,
        reason: str,
        resolution_id: str | None,
        ctx: WriteContext,
    ) -> Dispute:
        existing = await self.open_for_batch(session, batch_id)
        if existing is not None:
            raise AppError("CONFLICT", f"Batch {batch_id} already has an open dispute ({existing.id})")
        now = self._clock.now()
        row = Dispute(
            id=new_id("dispute"),
            type="SETTLEMENT",
            batch_id=batch_id,
            gw_payment_id=gw_payment_id,
            amount_minor=amount_minor,
            status="OPEN",
            reason=reason,
            resolution_id=resolution_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                ctx,
                action="dispute.raised",
                entity_type="settlement",
                entity_id=batch_id,
                summary=f"Raised settlement dispute {row.id} for {format_money(row.amount_minor)} on batch {batch_id}: {reason}",
                after={"disputeId": row.id, "amountMinor": row.amount_minor, "gwPaymentId": gw_payment_id},
            ),
        )
        return row
