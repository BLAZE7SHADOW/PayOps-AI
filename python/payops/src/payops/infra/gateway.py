"""Gateway adapter backed by the simulator's `gw_*` tables: the "external world". The rest of the backend reads gateway state only through the
`PaymentGateway` protocol, never from these tables directly. (Only the read side is ported so far; the write side comes with the executor.)"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.models import GwPayment, GwRefund, GwSettlementLine, GwWebhookDelivery
from ..domain.gateway import (
    CaptureSummary,
    GatewayPayment,
    GatewayRefund,
    GatewaySettlementLine,
    GatewayWebhookDelivery,
    WebhookAttempt,
)


def _payment(r: GwPayment) -> GatewayPayment:
    return GatewayPayment(
        id=r.id, order_ref=r.order_ref, merchant_id=r.merchant_id, amount_minor=r.amount_minor, status=r.status, method=r.method,
        card=r.card, captured_at=r.captured_at, refunded_minor=r.refunded_minor, created_at=r.created_at,
    )


def _refund(r: GwRefund) -> GatewayRefund:
    return GatewayRefund(id=r.id, gw_payment_id=r.gw_payment_id, amount_minor=r.amount_minor, status=r.status, processed_at=r.processed_at, created_at=r.created_at)


def _delivery(r: GwWebhookDelivery) -> GatewayWebhookDelivery:
    attempts = [
        WebhookAttempt(at=a["at"], http_status=a.get("httpStatus"), latency_ms=a.get("latencyMs", 0), error=a.get("error"))
        for a in (r.attempts or [])
    ]
    return GatewayWebhookDelivery(
        id=r.id, event=r.event, gw_payment_id=r.gw_payment_id, gw_refund_id=r.gw_refund_id, attempts=attempts, final_status=r.final_status,
        created_at=r.created_at,
    )


def _line(r: GwSettlementLine) -> GatewaySettlementLine:
    return GatewaySettlementLine(
        id=r.id, batch_id=r.batch_id, merchant_id=r.merchant_id, gw_payment_id=r.gw_payment_id, gross_minor=r.gross_minor, fee_minor=r.fee_minor,
        tax_minor=r.tax_minor, net_minor=r.net_minor, line_no=r.line_no, settled_on=r.settled_on,
    )


class SimulatorGateway:
    name = "simulator"

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def get_payments(self, ids: Sequence[str]) -> list[GatewayPayment]:
        if not ids:
            return []
        async with self._sessions() as s:
            return [_payment(r) for r in (await s.scalars(select(GwPayment).where(GwPayment.id.in_(list(ids))))).all()]

    async def list_payments_by_order(self, order_refs: Sequence[str]) -> list[GatewayPayment]:
        if not order_refs:
            return []
        async with self._sessions() as s:
            return [_payment(r) for r in (await s.scalars(select(GwPayment).where(GwPayment.order_ref.in_(list(order_refs))))).all()]

    async def list_webhook_deliveries(self, gw_payment_ids: Sequence[str]) -> list[GatewayWebhookDelivery]:
        if not gw_payment_ids:
            return []
        async with self._sessions() as s:
            rows = (await s.scalars(select(GwWebhookDelivery).where(GwWebhookDelivery.gw_payment_id.in_(list(gw_payment_ids))))).all()
            return [_delivery(r) for r in rows]

    async def list_refunds(self, gw_payment_ids: Sequence[str]) -> list[GatewayRefund]:
        if not gw_payment_ids:
            return []
        async with self._sessions() as s:
            return [_refund(r) for r in (await s.scalars(select(GwRefund).where(GwRefund.gw_payment_id.in_(list(gw_payment_ids))))).all()]

    async def list_settlement_lines(
        self, batch_ids: Sequence[str] | None = None, gw_payment_ids: Sequence[str] | None = None
    ) -> list[GatewaySettlementLine]:
        conditions = []
        if batch_ids:
            conditions.append(GwSettlementLine.batch_id.in_(list(batch_ids)))
        if gw_payment_ids:
            conditions.append(GwSettlementLine.gw_payment_id.in_(list(gw_payment_ids)))
        if not conditions:
            return []
        async with self._sessions() as s:
            return [_line(r) for r in (await s.scalars(select(GwSettlementLine).where(or_(*conditions)))).all()]

    async def summarize_captures(self, start: datetime, end: datetime) -> CaptureSummary:
        """Count and total of payments captured in [start, end). Used by the overview metrics."""
        async with self._sessions() as s:
            row = (
                await s.execute(
                    select(func.count(), func.coalesce(func.sum(GwPayment.amount_minor), 0)).where(
                        GwPayment.captured_at >= start, GwPayment.captured_at < end
                    )
                )
            ).one()
            return CaptureSummary(count=int(row[0]), amount_minor=int(row[1]))
