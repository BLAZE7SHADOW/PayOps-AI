"""Writes to our internal payment records (not the gateway's). (packages/core payment.service.ts)"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Payment
from ...domain.money import format_money
from ...errors import AppError, not_found
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from


class PaymentWriteService:
    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def _lock(self, session: AsyncSession, payment_id: str) -> Payment:
        row = (await session.scalars(select(Payment).where(Payment.id == payment_id).with_for_update())).one_or_none()
        if row is None:
            raise not_found("Payment", payment_id)
        return row

    async def set_status(self, session: AsyncSession, payment_id: str, status: str, reason: str, ctx: WriteContext) -> Payment | None:
        """Mirrors a gateway status onto our payment. A no-op (returns None) when already equal."""
        row = await self._lock(session, payment_id)
        if row.status == status:
            return None
        previous = row.status
        row.status = status
        row.updated_at = self._clock.now()
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                ctx, action="payment.status_changed", entity_type="payment", entity_id=payment_id,
                summary=f"Internal payment {payment_id} moved {previous} to {status}: {reason}", before={"status": previous}, after={"status": status},
            ),
        )
        return row

    async def hold(self, session: AsyncSession, payment_id: str, reason: str, ctx: WriteContext) -> Payment:
        """Freezes the payment so it is excluded from payouts until reviewed."""
        row = await self._lock(session, payment_id)
        if row.hold:
            raise AppError("CONFLICT", f"Payment {payment_id} is already on hold")
        row.hold = True
        row.updated_at = self._clock.now()
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                ctx, action="payment.held", entity_type="payment", entity_id=payment_id,
                summary=f"Payment {payment_id} ({format_money(row.amount_minor)}) put on hold: {reason}", before={"hold": False}, after={"hold": True},
            ),
        )
        return row
