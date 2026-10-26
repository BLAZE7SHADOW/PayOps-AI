"""Our refund records. A refund is created REQUESTED before we call the gateway, linked to the gateway refund once it
exists, and marked PROCESSED (with its ledger journal) when the gateway confirms, either by webhook or by an analyst
syncing the status. (packages/core refund.service.ts)"""

from __future__ import annotations

from sqlalchemy import and_, asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Payment, Refund
from ...domain.gateway import GatewayPayment, GatewayRefund
from ...domain.ids import new_id
from ...domain.money import format_money
from ...errors import not_found
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from
from .ledger import LedgerWriteService
from .payments import PaymentWriteService

#: Our refund status that corresponds to a gateway refund status.
REFUND_STATUS_FROM_GATEWAY = {"PENDING": "PENDING", "PROCESSED": "PROCESSED", "FAILED": "FAILED"}


class RefundWriteService:
    def __init__(
        self, clock: Clock, audit: AuditService, ledger: LedgerWriteService, payments: PaymentWriteService
    ) -> None:
        self._clock = clock
        self._audit = audit
        self._ledger = ledger
        self._payments = payments

    async def lock(self, session: AsyncSession, refund_id: str) -> Refund:
        row = (
            await session.scalars(
                select(Refund).where(Refund.id == refund_id).with_for_update().execution_options(populate_existing=True)
            )
        ).one_or_none()
        if row is None:
            raise not_found("Refund", refund_id)
        return row

    async def create_requested(
        self, session: AsyncSession, *, gw_payment_id: str, amount_minor: int, reason: str, ctx: WriteContext
    ) -> Refund:
        """Records our intent to refund before the gateway is called."""
        payment_id = (
            await session.scalars(select(Payment.id).where(Payment.gw_payment_id == gw_payment_id).limit(1))
        ).first()
        now = self._clock.now()
        row = Refund(
            id=new_id("refund"),
            payment_id=payment_id,
            gw_payment_id=gw_payment_id,
            gw_refund_id=None,
            amount_minor=amount_minor,
            status="REQUESTED",
            reason=reason,
            requested_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                ctx,
                action="refund.requested",
                entity_type="refund",
                entity_id=row.id,
                summary=f"Refund {row.id} of {format_money(row.amount_minor)} requested on {gw_payment_id}: {reason}",
                after={"amountMinor": row.amount_minor, "gwPaymentId": gw_payment_id, "paymentId": row.payment_id},
            ),
        )
        return row

    async def find_for_gateway_refund(self, session: AsyncSession, gw: GatewayRefund) -> Refund | None:
        """The internal refund a gateway refund belongs to: the one already linked to it, else the oldest unlinked
        REQUESTED or PENDING refund on the same payment for the same amount."""
        linked = (
            await session.scalars(select(Refund).where(Refund.gw_refund_id == gw.id).with_for_update().limit(1))
        ).first()
        if linked is not None:
            return linked
        return (
            await session.scalars(
                select(Refund)
                .where(
                    and_(
                        Refund.gw_payment_id == gw.gw_payment_id,
                        Refund.amount_minor == gw.amount_minor,
                        Refund.gw_refund_id.is_(None),
                        Refund.status.in_(["REQUESTED", "PENDING"]),
                    )
                )
                .order_by(asc(Refund.requested_at), asc(Refund.id))
                .with_for_update()
                .limit(1)
            )
        ).first()

    async def apply_gateway_status(
        self,
        session: AsyncSession,
        refund: Refund,
        gw: GatewayRefund,
        gw_payment: GatewayPayment,
        source: str,
        ctx: WriteContext,
    ) -> Refund:
        """Brings our refund in line with the gateway refund: links it, copies the status, and for PROCESSED posts the
        refund journal (once) and mirrors the payment's refunded status. Returns the refund after the change."""
        status = REFUND_STATUS_FROM_GATEWAY[gw.status]
        row = refund
        if refund.status != status or refund.gw_refund_id != gw.id:
            previous_status, previous_link = refund.status, refund.gw_refund_id
            row.status = status
            row.gw_refund_id = gw.id
            row.updated_at = self._clock.now()
            await session.flush()
            await self._audit.record(
                session,
                audit_from(
                    ctx,
                    action="refund.status_changed",
                    entity_type="refund",
                    entity_id=refund.id,
                    summary=f"Refund {refund.id} moved {previous_status} to {status} to match gateway refund {gw.id}",
                    before={"status": previous_status, "gwRefundId": previous_link},
                    after={"status": status, "gwRefundId": gw.id},
                ),
            )
        if status == "PROCESSED":
            if not await self._ledger.has_live_refund_journal(session, row.id):
                await self._ledger.post_refund(
                    session,
                    refund_id=row.id,
                    payment_id=row.payment_id,
                    gw_payment_id=row.gw_payment_id,
                    merchant_id=gw_payment.merchant_id,
                    amount_minor=row.amount_minor,
                    source=source,
                    ctx=ctx,
                )
            if row.payment_id and gw_payment.status in ("REFUNDED", "PARTIALLY_REFUNDED"):
                await self._payments.set_status(
                    session, row.payment_id, gw_payment.status, f"gateway shows the payment {gw_payment.status}", ctx
                )
        return row

    async def mark_failed(self, session: AsyncSession, refund: Refund, reason: str, ctx: WriteContext) -> None:
        previous = refund.status
        refund.status = "FAILED"
        refund.updated_at = self._clock.now()
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                ctx,
                action="refund.status_changed",
                entity_type="refund",
                entity_id=refund.id,
                summary=f"Refund {refund.id} marked FAILED: {reason}",
                before={"status": previous},
                after={"status": "FAILED"},
            ),
        )
