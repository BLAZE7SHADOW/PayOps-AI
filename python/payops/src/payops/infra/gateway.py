"""Gateway adapter backed by the simulator's `gw_*` tables: the "external world". The rest of the backend reads gateway state only through the
`PaymentGateway` protocol, never from these tables directly."""

from __future__ import annotations

import time
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
    WebhookDeliveryResult,
    WebhookSink,
)
from ..domain.ids import new_id
from ..domain.money import format_money
from ..domain.timeutil import to_iso
from ..errors import AppError
from ..ports import Clock, SystemClock


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

    def __init__(self, session_factory: async_sessionmaker[AsyncSession], clock: Clock | None = None) -> None:
        self._sessions = session_factory
        self._clock = clock or SystemClock()
        self._sink: WebhookSink | None = None

    def set_webhook_sink(self, sink: WebhookSink) -> None:
        """Where deliveries go: our webhook log, which runs the consumer and records the attempt."""
        self._sink = sink

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

    # ── Writes ───────────────────────────────────────────────────────────────
    async def replay_webhook(self, event_id: str) -> WebhookDeliveryResult:
        async with self._sessions() as s:
            row = await s.get(GwWebhookDelivery, event_id)
            if row is None:
                raise AppError("NOT_FOUND", f"Webhook event {event_id} not found at the gateway")
            delivery = _delivery(row)
        return await self._deliver(delivery)

    async def create_refund(self, gw_payment_id: str, amount_minor: int) -> GatewayRefund:
        now = self._clock.now()
        async with self._sessions.begin() as s:
            payment = (await s.scalars(select(GwPayment).where(GwPayment.id == gw_payment_id).with_for_update())).one_or_none()
            if payment is None:
                raise AppError("NOT_FOUND", f"Gateway payment {gw_payment_id} not found")
            if payment.status not in ("CAPTURED", "PARTIALLY_REFUNDED"):
                raise AppError("CONFLICT", f"Gateway refused the refund: payment {payment.id} is {payment.status}")
            refundable = payment.amount_minor - payment.refunded_minor
            if amount_minor <= 0 or amount_minor > refundable:
                raise AppError("CONFLICT", f"Gateway refused the refund: {format_money(amount_minor)} exceeds the refundable {format_money(refundable)}")
            # The simulated gateway processes refunds instantly.
            refunded = payment.refunded_minor + amount_minor
            created = GwRefund(id=new_id("gwRefund"), gw_payment_id=payment.id, amount_minor=amount_minor, status="PROCESSED", processed_at=now, created_at=now, updated_at=now)
            s.add(created)
            payment.refunded_minor = refunded
            payment.status = "REFUNDED" if refunded >= payment.amount_minor else "PARTIALLY_REFUNDED"
            payment.updated_at = now
            event_id = new_id("webhookEvent")
            s.add(GwWebhookDelivery(id=event_id, event="refund.processed", gw_payment_id=payment.id, gw_refund_id=created.id, attempts=[], final_status="PENDING", created_at=now, updated_at=now))
            await s.flush()
            refund = _refund(created)
        # Delivered after the gateway's own commit, exactly like a real webhook.
        await self.replay_webhook(event_id)
        return refund

    async def _deliver(self, event: GatewayWebhookDelivery) -> WebhookDeliveryResult:
        """One delivery attempt: hand the event to the sink (our consumer runs its own transaction), then record the attempt. Strictly sequential, never nested."""
        at = self._clock.now()
        started = time.monotonic()
        http_status: int | None = None
        error: str | None = None
        if self._sink is None:
            error = "No webhook endpoint configured"
        else:
            try:
                http_status = await self._sink(event)
            except Exception as exc:  # noqa: BLE001 - a consumer crash is a 500 to the gateway, like over HTTP
                http_status = 500
                error = str(exc) or "Consumer error"
        ok = http_status is not None and 200 <= http_status < 300
        if not ok and error is None:
            error = "Conflict" if http_status == 409 else "Consumer rejected the event"
        attempt = {"at": to_iso(at), "httpStatus": http_status, "latencyMs": int((time.monotonic() - started) * 1000), "error": error}
        async with self._sessions.begin() as s:
            row = (await s.scalars(select(GwWebhookDelivery).where(GwWebhookDelivery.id == event.id).with_for_update())).one()
            row.attempts = [*row.attempts, attempt]
            row.final_status = "DELIVERED" if ok else "FAILED"
            row.updated_at = at
        return WebhookDeliveryResult(http_status=http_status, attempt_at=attempt["at"])
