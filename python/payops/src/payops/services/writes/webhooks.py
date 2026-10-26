"""Inbound webhooks: our consumer (what the gateway calls when something happens to a payment) and the event log with
replay and retry. (packages/core webhook-consumer.ts, webhook-event.service.ts)

The consumer answers like an HTTP handler (2xx processed, 409 conflict, 5xx error) and works in its OWN transaction, so
the gateway can record the delivery attempt only after it returns. A failed event is retried on the schedule in
`domain/webhook_retry.py`; after the last attempt it is DEAD and only a person can replay it."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import Order, Payment, WebhookEvent
from ...domain.gateway import GatewayWebhookDelivery, PaymentGateway
from ...domain.reconciliation.facts import CAPTURE_KNOWN_STATUSES, capture_credit_minor, is_captured
from ...domain.timeutil import parse_iso, to_iso
from ...domain.webhook_retry import is_webhook_success, webhook_retry_delay_seconds
from ...dto.webhooks import WebhookLogDetail
from ...errors import AppError, not_found
from ...ports import Clock
from ..audit import WEBHOOK_CONSUMER_ACTOR, AuditInput, AuditService, WriteContext
from ..webhooks import to_detail
from .ledger import LedgerWriteService
from .orders import OrderService, TransitionOptions
from .payments import PaymentWriteService
from .refunds import RefundWriteService

_CTX = WriteContext(actor=WEBHOOK_CONSUMER_ACTOR)


@dataclass(frozen=True)
class ConsumerResult:
    http_status: int
    #: PROCESSED, NO_OP, ORDER_VERSION_CONFLICT or ERROR.
    outcome: str
    message: str


def _noop(message: str) -> ConsumerResult:
    return ConsumerResult(200, "NO_OP", message)


def _consumer_audit(action: str, entity_type: str, entity_id: str, summary: str) -> AuditInput:
    a = WEBHOOK_CONSUMER_ACTOR
    return AuditInput(a.actor_type, a.actor_id, a.actor_name, action, entity_type, entity_id, summary)


class WebhookConsumer:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        gateway: PaymentGateway,
        audit: AuditService,
        orders: OrderService,
        payments: PaymentWriteService,
        ledger: LedgerWriteService,
        refunds: RefundWriteService,
    ) -> None:
        self._sessions = sessions
        self._gateway = gateway
        self._audit = audit
        self._orders = orders
        self._payments = payments
        self._ledger = ledger
        self._refunds = refunds

    async def handle(self, event: GatewayWebhookDelivery) -> ConsumerResult:
        try:
            if event.event == "payment.captured":
                return await self._payment_captured(event)
            if event.event in ("refund.processed", "refund.failed"):
                return await self._refund_updated(event)
            return _noop(f"{event.event} needs no action")
        except AppError as err:
            if err.code in ("VERSION_CONFLICT", "INVALID_TRANSITION"):
                return ConsumerResult(409, "ORDER_VERSION_CONFLICT", err.message)
            return ConsumerResult(500, "ERROR", err.message)
        except Exception as err:  # noqa: BLE001 - the gateway only needs to see a 500
            return ConsumerResult(500, "ERROR", str(err) or "Consumer error")

    async def _payment_captured(self, event: GatewayWebhookDelivery) -> ConsumerResult:
        gw = (await self._gateway.get_payments([event.gw_payment_id]) or [None])[0]
        if gw is None or not is_captured(gw):
            return _noop(f"Gateway payment {event.gw_payment_id} is not captured")
        async with transaction(self._sessions) as s:
            payment = (
                await s.scalars(select(Payment).where(Payment.gw_payment_id == gw.id).with_for_update().limit(1))
            ).first()
            if payment is None:
                return _noop(f"No internal payment for {gw.id}; ignored")
            order = await s.get(Order, payment.order_id)
            if order is None:
                return _noop(f"Order {payment.order_id} not found; ignored")
            if order.locked_reason:
                # Injected fault (replay_fails_then_replan): the order service rejects webhook-driven transitions.
                # Nothing is written.
                return ConsumerResult(
                    409, "ORDER_VERSION_CONFLICT", f"Order {order.id} rejected the update: {order.locked_reason}"
                )
            changes: list[str] = []
            if payment.status not in CAPTURE_KNOWN_STATUSES:
                await self._payments.set_status(s, payment.id, "CAPTURED", f"payment.captured {event.id}", _CTX)
                changes.append("payment CAPTURED")
            if order.status in ("PENDING", "FAILED"):
                previous = order.status
                await self._orders.transition(
                    s,
                    order.id,
                    "PAID",
                    TransitionOptions(
                        by="webhook-consumer", reason=f"payment.captured {event.id}", payment_id=payment.id
                    ),
                    _CTX,
                )
                changes.append(f"order {previous} to PAID")
            if order.payment_id is None or order.payment_id == payment.id:
                entries = await self._ledger.entries_for_payment(s, payment.id)
                if capture_credit_minor(_Ledger(entries)) == 0:
                    await self._ledger.post_capture(
                        s,
                        payment_id=payment.id,
                        merchant_id=payment.merchant_id,
                        amount_minor=gw.amount_minor,
                        source="SYSTEM",
                        ctx=_CTX,
                    )
                    changes.append("capture posted")
            message = f"Processed {event.id}: {', '.join(changes)}" if changes else f"{event.id} already reflected"
            await self._audit.record(s, _consumer_audit("webhook.processed", "payment", payment.id, message))
            return ConsumerResult(200, "PROCESSED" if changes else "NO_OP", message)

    async def _refund_updated(self, event: GatewayWebhookDelivery) -> ConsumerResult:
        if not event.gw_refund_id:
            return _noop(f"{event.id} carries no refund id")
        gw_refunds = await self._gateway.list_refunds([event.gw_payment_id])
        gw_payment = (await self._gateway.get_payments([event.gw_payment_id]) or [None])[0]
        gw_refund = next((r for r in gw_refunds if r.id == event.gw_refund_id), None)
        if gw_refund is None or gw_payment is None:
            return _noop(f"Gateway refund {event.gw_refund_id} not found")
        if gw_refund.status == "PENDING":
            return _noop(f"Gateway refund {gw_refund.id} is still PENDING")
        async with transaction(self._sessions) as s:
            refund = await self._refunds.find_for_gateway_refund(s, gw_refund)
            if refund is None:
                return _noop(f"No internal refund matches {gw_refund.id}; ignored")
            if gw_refund.status == "FAILED":
                if refund.status != "FAILED":
                    await self._refunds.mark_failed(s, refund, f"gateway refund {gw_refund.id} failed", _CTX)
            else:
                await self._refunds.apply_gateway_status(s, refund, gw_refund, gw_payment, "SYSTEM", _CTX)
            message = f"Processed {event.id}: refund {refund.id} {gw_refund.status}"
            await self._audit.record(s, _consumer_audit("webhook.processed", "refund", refund.id, message))
            return ConsumerResult(200, "PROCESSED", message)


class _Ledger:
    def __init__(self, ledger: list) -> None:  # type: ignore[type-arg]
        self.ledger = ledger


class RetryScheduler(Protocol):
    """Queues a delayed retry job. The job queue backs this in production; tests use a fake."""

    async def schedule(self, event_id: str, delay_seconds: int) -> None: ...


#: Who triggered the delivery that is running now. The gateway's sink has no way to say.
_SOURCE: ContextVar[str] = ContextVar("webhook_attempt_source", default="GATEWAY")


class WebhookEventService:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        clock: Clock,
        audit: AuditService,
        consumer: WebhookConsumer,
        gateway: PaymentGateway,
        scheduler: RetryScheduler | None = None,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._audit = audit
        self._consumer = consumer
        self._gateway = gateway
        self._scheduler = scheduler

    def set_scheduler(self, scheduler: RetryScheduler) -> None:
        self._scheduler = scheduler

    async def receive(self, event: GatewayWebhookDelivery) -> int:
        """The gateway's webhook sink: run the consumer, log the attempt, queue a retry if it failed. Returns the HTTP
        status."""
        result = await self._consumer.handle(event)
        row = await self._record(event, result, _SOURCE.get())
        if row.next_retry_at is not None and self._scheduler is not None:
            delay = round((row.next_retry_at - self._clock.now()).total_seconds())
            try:
                await self._scheduler.schedule(row.id, delay)
            except Exception:  # noqa: BLE001 - a queue outage must not turn a logged failure into a lost one: the row keeps next_retry_at
                pass
        return result.http_status

    async def retry(self, event_id: str) -> str:
        """Runs from the retry job. Does nothing unless the event is FAILED and its retry time has come."""
        row = await self._find(event_id)
        if row is None or row.status != "FAILED" or row.next_retry_at is None or row.next_retry_at > self._clock.now():
            return "SKIPPED"
        await self._redeliver(row, "RETRY")
        return "RETRIED"

    async def replay(self, event_id: str, by_id: str, by_name: str) -> WebhookLogDetail:
        """A person replays an event from the log, whatever its status."""
        row = await self._find(event_id)
        if row is None:
            raise not_found("Webhook event", event_id)
        before = row.status
        await self._redeliver(row, "MANUAL")
        after = await self._find(event_id)
        if after is None:
            raise not_found("Webhook event", event_id)
        async with transaction(self._sessions) as s:
            await self._audit.record(
                s,
                AuditInput(
                    "USER",
                    by_id,
                    by_name,
                    "webhook.replayed",
                    "webhook_event",
                    event_id,
                    f"Replayed {row.event} {event_id} from the event log: {after.last_message} ({before} to {after.status})",
                ),
            )
        return to_detail(after)

    async def _find(self, event_id: str) -> WebhookEvent | None:
        async with self._sessions() as s:
            return await s.get(WebhookEvent, event_id)

    async def _redeliver(self, row: WebhookEvent, source: str) -> None:
        token = _SOURCE.set(source)
        try:
            try:
                await self._gateway.replay_webhook(row.id)
            except AppError as err:
                if err.code != "NOT_FOUND":
                    raise
                # The gateway no longer has the event: use the stored payload.
                p = row.payload
                await self.receive(
                    GatewayWebhookDelivery(
                        id=p["id"],
                        event=p["event"],
                        gw_payment_id=p["gwPaymentId"],
                        gw_refund_id=p.get("gwRefundId"),
                        attempts=[],
                        final_status="FAILED",
                        created_at=parse_iso(p["createdAt"]),
                    )
                )
        finally:
            _SOURCE.reset(token)

    async def _record(self, event: GatewayWebhookDelivery, result: ConsumerResult, source: str) -> WebhookEvent:
        now = self._clock.now()
        async with transaction(self._sessions) as s:
            existing = (
                await s.scalars(select(WebhookEvent).where(WebhookEvent.id == event.id).with_for_update())
            ).one_or_none()
            was_dead = existing is not None and existing.status == "DEAD"
            attempts = [
                *(existing.attempts if existing else []),
                {
                    "at": to_iso(now),
                    "source": source,
                    "httpStatus": result.http_status,
                    "outcome": result.outcome,
                    "message": result.message,
                },
            ]
            ok = is_webhook_success(result.http_status)
            delay = None if ok or was_dead else webhook_retry_delay_seconds(len(attempts))
            status = "PROCESSED" if ok else "DEAD" if delay is None else "FAILED"
            next_retry = None if delay is None else now + timedelta(seconds=delay)
            if existing is None:
                row = WebhookEvent(
                    id=event.id,
                    event=event.event,
                    gw_payment_id=event.gw_payment_id,
                    gw_refund_id=event.gw_refund_id,
                    payload={
                        "id": event.id,
                        "event": event.event,
                        "gwPaymentId": event.gw_payment_id,
                        "gwRefundId": event.gw_refund_id,
                        "createdAt": to_iso(event.created_at),
                    },
                    first_received_at=now,
                    status=status,
                    attempts=attempts,
                    attempt_count=len(attempts),
                    last_http_status=result.http_status,
                    last_message=result.message,
                    next_retry_at=next_retry,
                    updated_at=now,
                )
                s.add(row)
            else:
                row = existing
                row.status, row.attempts, row.attempt_count = status, attempts, len(attempts)
                row.last_http_status, row.last_message, row.next_retry_at, row.updated_at = (
                    result.http_status,
                    result.message,
                    next_retry,
                    now,
                )
            await s.flush()
            if status == "DEAD" and not was_dead:
                a = WEBHOOK_CONSUMER_ACTOR
                await self._audit.record(
                    s,
                    AuditInput(
                        a.actor_type,
                        a.actor_id,
                        a.actor_name,
                        "webhook.dead",
                        "webhook_event",
                        event.id,
                        f"{event.event} {event.id} failed {len(attempts)} times and is out of automatic retries: {result.message}",
                    ),
                )
            return row
