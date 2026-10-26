"""Writes one coherent payment lifecycle across both worlds (gateway tables and our internal tables), with optional
injected faults. Every timestamp derives from `at`, so a scenario can be backdated relative to the clock and the
detection rules see realistic ages. The order of every call on the id generator is the order the TypeScript simulator
used: it is what makes the same seed give the same ids."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ..db.models import (
    GwPayment,
    GwRefund,
    GwWebhookDelivery,
    LedgerEntry,
    Order,
    Payment,
    PaymentAttempt,
    Refund,
    SupportNote,
    WebhookEvent,
)
from ..domain.timeutil import to_iso
from .context import MERCHANT_CYCLE_MS, PendingLine, ScenarioContext
from .world import WorldCustomer, WorldMerchant

SECOND_MS = 1_000
MINUTE_MS = 60 * SECOND_MS


@dataclass
class CardDetails:
    network: str
    country: str
    last4: str

    def to_json(self) -> dict[str, str]:
        return {"last4": self.last4, "network": self.network, "country": self.country}


@dataclass
class GatewayRefundOptions:
    status: str
    processed_at: datetime | None = None


@dataclass
class RefundOptions:
    requested_at: datetime
    reason: str
    #: Our refund record's status. PROCESSED also posts the refund journal to the ledger.
    internal_status: str
    amount_minor: int | None = None
    #: What the gateway did with it; None if the refund never reached the gateway.
    gateway: GatewayRefundOptions | None = None
    #: Delivery of refund.processed to us.
    webhook: str | None = None
    #: The gateway refunded but we never created our own refund record (no ledger posting either).
    skip_internal: bool = False


@dataclass
class CustomerNote:
    text: str
    at: datetime


@dataclass
class CheckoutOptions:
    amount_minor: int
    #: When the customer started checkout (order created).
    at: datetime
    customer: WorldCustomer
    merchant: WorldMerchant
    method: str | None = None
    card: CardDetails | None = None
    #: payment.captured delivery. "fails" = 3 attempts, HTTP 500, and the order times out. "pending" = two HTTP 503
    #: attempts and a retry still scheduled.
    webhook: str | None = None
    #: Out-of-order events: a stale payment.failed is applied after the capture and flips the order to FAILED.
    stale_failure_at: datetime | None = None
    #: The customer cancelled before the capture landed; the consumer still posted the ledger credit.
    cancelled_before_capture_at: datetime | None = None
    #: Order service rejects webhook-driven transitions (fault for replay_fails_then_replan).
    order_locked: bool = False
    #: Webhook processed but the ledger posting was lost.
    skip_ledger: bool = False
    #: Include in a settlement file when T+1 has passed. Default true.
    settle: bool = True
    #: Settlement group key; payments with the same group and merchant share a batch.
    batch_group: str | None = None
    #: Fee the gateway actually charges on this line, if different from the contract.
    fee_bps_override: int | None = None
    #: The gateway captures the order a second time a minute later.
    second_capture: bool = False
    #: Merchant cancels the order at this time.
    cancel_at: datetime | None = None
    cancel_reason: str | None = None
    refund: RefundOptions | None = None
    device_id: str | None = None
    #: Free-text complaint from the customer (untrusted).
    customer_note: CustomerNote | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class CheckoutResult:
    order_id: str
    payment_id: str
    gw_payment_id: str
    extra_gw_payment_ids: list[str]
    captured_at: datetime


_CARD_DEFAULT = CardDetails("VISA", "IN", "4242")


def plus(d: datetime, ms: float) -> datetime:
    return d + timedelta(milliseconds=ms)


async def checkout(ctx: ScenarioContext, o: CheckoutOptions) -> CheckoutResult:
    tx, ids = ctx.tx, ctx.ids
    method = o.method or "CARD"
    card = (o.card or _CARD_DEFAULT) if method == "CARD" else None
    webhook = o.webhook or "delivered"
    order_id = ids.next("order")
    payment_id = ids.next("payment")
    gw_payment_id = ids.next("gwPayment")
    gw_created_at = plus(o.at, 20 * SECOND_MS)
    captured_at = plus(o.at, 30 * SECOND_MS)
    device_id = o.device_id or o.customer.device_id

    # ── Order and internal payment as the order service sees them ───────────
    timeline: list[dict[str, Any]] = [
        {"at": to_iso(o.at), "from": None, "to": "PENDING", "by": "checkout", "reason": None}
    ]
    status = "PENDING"

    def move(at: datetime, to: str, by: str, reason: str | None = None) -> None:
        nonlocal status
        timeline.append({"at": to_iso(at), "from": status, "to": to, "by": by, "reason": reason})
        status = to

    delivered = webhook == "delivered"
    if o.cancelled_before_capture_at:
        move(
            o.cancelled_before_capture_at, "CANCELLED", "customer", "Customer cancelled while the payment was in flight"
        )
    elif delivered:
        move(plus(captured_at, 2 * SECOND_MS), "PAID", "webhook-consumer")
    elif webhook == "pending":
        pass  # Order stays PENDING while the gateway keeps retrying the webhook.
    else:
        move(plus(o.at, 15 * MINUTE_MS), "FAILED", "checkout-timeout", "No payment confirmation within 15 min")
    if o.stale_failure_at:
        move(
            o.stale_failure_at,
            "FAILED",
            "webhook-consumer",
            "payment.failed from an earlier attempt applied after the capture",
        )
    if o.cancel_at:
        move(o.cancel_at, "CANCELLED", "merchant", o.cancel_reason or "Cancelled by merchant")

    tx.add(
        Order(
            id=order_id,
            merchant_id=o.merchant.id,
            customer_id=o.customer.id,
            amount_minor=o.amount_minor,
            status=status,
            payment_id=payment_id,
            version=len(timeline) - 1,
            locked_reason="VERSION_CONFLICT" if o.order_locked else None,
            timeline=timeline,
            created_at=o.at,
            updated_at=datetime.fromisoformat(timeline[-1]["at"]),
        )
    )

    # ── Gateway: payment, captured ───────────────────────────────────────────
    refund = o.refund
    refund_amount = refund.amount_minor if refund and refund.amount_minor is not None else o.amount_minor
    gw_refund_processed = bool(refund and refund.gateway and refund.gateway.status == "PROCESSED")
    tx.add(
        GwPayment(
            id=gw_payment_id,
            order_ref=order_id,
            merchant_id=o.merchant.id,
            amount_minor=o.amount_minor,
            status=("REFUNDED" if refund_amount >= o.amount_minor else "PARTIALLY_REFUNDED")
            if gw_refund_processed
            else "CAPTURED",
            method=method,
            card=card.to_json() if card else None,
            captured_at=captured_at,
            refunded_minor=refund_amount if gw_refund_processed else 0,
            created_at=gw_created_at,
            updated_at=captured_at,
            currency="INR",
        )
    )
    # The order row references the payment and the payment references the order: the gateway row first, then both
    # internal rows.
    await tx.flush()
    tx.add(
        Payment(
            id=payment_id,
            gw_payment_id=gw_payment_id,
            order_id=order_id,
            merchant_id=o.merchant.id,
            customer_id=o.customer.id,
            amount_minor=o.amount_minor,
            method=method,
            status=("REFUNDED" if refund and refund.internal_status == "PROCESSED" else "CAPTURED")
            if delivered
            else "PENDING",
            created_at=gw_created_at,
            updated_at=captured_at,
            recon=None,
            hold=False,
            mismatch=False,
        )
    )
    tx.add(
        PaymentAttempt(
            id=ids.next("attempt"),
            customer_id=o.customer.id,
            device_id=device_id,
            order_id=order_id,
            amount_minor=o.amount_minor,
            result="SUCCESS",
            failure_code=None,
            card_country=card.country if card else None,
            at=plus(o.at, 25 * SECOND_MS),
        )
    )
    await tx.flush()

    await insert_delivery(ctx, "payment.captured", gw_payment_id, None, plus(captured_at, SECOND_MS), webhook)

    if delivered and not o.skip_ledger:
        await post_journal(
            ctx,
            payment_id=payment_id,
            refund_id=None,
            merchant_id=o.merchant.id,
            amount_minor=o.amount_minor,
            posted_at=plus(captured_at, 3 * SECOND_MS),
            debit="SETTLEMENT_CLEARING",
            credit="MERCHANT_PAYABLE",
            memo=f"Capture {gw_payment_id}",
        )

    # ── Optional second capture on the same order (gateway-side duplicate) ───
    extra_gw_payment_ids: list[str] = []
    if o.second_capture:
        dup_id = ids.next("gwPayment")
        dup_captured_at = plus(captured_at, 2 * MINUTE_MS)
        extra_gw_payment_ids.append(dup_id)
        tx.add(
            GwPayment(
                id=dup_id,
                order_ref=order_id,
                merchant_id=o.merchant.id,
                amount_minor=o.amount_minor,
                status="CAPTURED",
                method=method,
                card=card.to_json() if card else None,
                captured_at=dup_captured_at,
                refunded_minor=0,
                created_at=plus(dup_captured_at, -10 * SECOND_MS),
                updated_at=dup_captured_at,
                currency="INR",
            )
        )
        tx.add(
            PaymentAttempt(
                id=ids.next("attempt"),
                customer_id=o.customer.id,
                device_id=device_id,
                order_id=order_id,
                amount_minor=o.amount_minor,
                result="SUCCESS",
                failure_code=None,
                card_country=card.country if card else None,
                at=plus(dup_captured_at, -5 * SECOND_MS),
            )
        )
        await tx.flush()
        # Delivered, but the consumer ignores it: the order is already PAID.
        await insert_delivery(ctx, "payment.captured", dup_id, None, plus(dup_captured_at, SECOND_MS), "delivered")

    # ── Optional refund ──────────────────────────────────────────────────────
    if refund:
        await write_refund(ctx, refund, refund_amount, payment_id, gw_payment_id, o.merchant.id)

    if o.customer_note:
        tx.add(
            SupportNote(
                id=ids.next("note"),
                payment_id=payment_id,
                order_id=order_id,
                author_type="CUSTOMER",
                text_=o.customer_note.text,
                created_at=o.customer_note.at,
                quarantined=False,
                complaint_type=None,
                urgent=None,
                injection_probability=None,
            )
        )

    # ── Settlement file (T+1) ────────────────────────────────────────────────
    if o.settle:
        captures: list[tuple[str, datetime, str | None]] = [
            (gw_payment_id, captured_at, payment_id),
            *[(i, plus(captured_at, 2 * MINUTE_MS), None) for i in extra_gw_payment_ids],
        ]
        for cap_id, cap_at, cap_payment in captures:
            if plus(cap_at, MERCHANT_CYCLE_MS) > ctx.now:
                continue
            ctx.queue_settlement(
                PendingLine(
                    group=o.batch_group or "main",
                    merchant=o.merchant,
                    gw_payment_id=cap_id,
                    payment_id=cap_payment,
                    gross_minor=o.amount_minor,
                    captured_at=cap_at,
                    fee_bps=o.fee_bps_override if o.fee_bps_override is not None else o.merchant.fee_bps,
                )
            )

    ctx.created.order_ids.append(order_id)
    ctx.created.payment_ids.append(payment_id)
    return CheckoutResult(order_id, payment_id, gw_payment_id, extra_gw_payment_ids, captured_at)


async def write_refund(
    ctx: ScenarioContext,
    refund: RefundOptions,
    amount_minor: int,
    payment_id: str,
    gw_payment_id: str,
    merchant_id: str,
) -> None:
    tx, ids = ctx.tx, ctx.ids
    refund_id = ids.next("refund")
    gw = refund.gateway
    gw_refund_id = ids.next("gwRefund") if gw else None
    gw_created_at = plus(refund.requested_at, MINUTE_MS)
    if gw and gw_refund_id:
        processed_at = None if gw.status == "PENDING" else (gw.processed_at or plus(gw_created_at, 6 * 60 * MINUTE_MS))
        tx.add(
            GwRefund(
                id=gw_refund_id,
                gw_payment_id=gw_payment_id,
                amount_minor=amount_minor,
                status=gw.status,
                processed_at=processed_at,
                created_at=gw_created_at,
                updated_at=processed_at or gw_created_at,
            )
        )
        await tx.flush()
        if processed_at and gw.status == "PROCESSED":
            await insert_delivery(
                ctx,
                "refund.processed",
                gw_payment_id,
                gw_refund_id,
                plus(processed_at, SECOND_MS),
                refund.webhook or "delivered",
            )
    if refund.skip_internal:
        return
    updated_at = (
        plus(gw.processed_at, 2 * SECOND_MS)
        if refund.internal_status == "PROCESSED" and gw and gw.processed_at
        else refund.requested_at
    )
    tx.add(
        Refund(
            id=refund_id,
            payment_id=payment_id,
            gw_payment_id=gw_payment_id,
            gw_refund_id=gw_refund_id,
            amount_minor=amount_minor,
            status=refund.internal_status,
            reason=refund.reason,
            requested_at=refund.requested_at,
            created_at=refund.requested_at,
            updated_at=updated_at,
        )
    )
    await tx.flush()
    if refund.internal_status == "PROCESSED":
        await post_journal(
            ctx,
            payment_id=payment_id,
            refund_id=refund_id,
            merchant_id=merchant_id,
            amount_minor=amount_minor,
            posted_at=updated_at,
            debit="MERCHANT_PAYABLE",
            credit="SETTLEMENT_CLEARING",
            memo=f"Refund {refund_id}",
        )


async def post_journal(
    ctx: ScenarioContext,
    *,
    payment_id: str,
    refund_id: str | None,
    merchant_id: str,
    amount_minor: int,
    posted_at: datetime,
    debit: str,
    credit: str,
    memo: str,
) -> None:
    """Two legs of one balanced posting."""
    journal_id = ctx.ids.next("journal")
    for account, direction in ((debit, "DEBIT"), (credit, "CREDIT")):
        ctx.tx.add(
            LedgerEntry(
                id=ctx.ids.next("ledgerEntry"),
                journal_id=journal_id,
                payment_id=payment_id,
                refund_id=refund_id,
                merchant_id=merchant_id,
                account=account,
                direction=direction,
                amount_minor=amount_minor,
                posted_at=posted_at,
                source="SYSTEM",
                memo=memo,
                batch_id=None,
                reversal_of=None,
            )
        )
    await ctx.tx.flush()


#: Retry schedule for failed deliveries: immediately, +5 min, +30 min.
_RETRY_OFFSETS_MS = (0, 5 * MINUTE_MS, 30 * MINUTE_MS)


async def insert_delivery(
    ctx: ScenarioContext, event: str, gw_payment_id: str, gw_refund_id: str | None, first_at: datetime, outcome: str
) -> None:
    if outcome == "delivered":
        attempts = [{"at": to_iso(first_at), "httpStatus": 200, "latencyMs": ctx.ids.int(90, 420), "error": None}]
    else:
        offsets = _RETRY_OFFSETS_MS[:2] if outcome == "pending" else _RETRY_OFFSETS_MS
        attempts = [
            {
                "at": to_iso(plus(first_at, offset)),
                "httpStatus": 503 if outcome == "pending" else 500,
                "latencyMs": ctx.ids.int(850, 1_600),
                "error": "Service Unavailable" if outcome == "pending" else "Internal Server Error",
            }
            for offset in offsets
        ]
    last_at = datetime.fromisoformat(attempts[-1]["at"])  # type: ignore[arg-type]
    event_id = ctx.ids.next("webhookEvent")
    final_status = "DELIVERED" if outcome == "delivered" else "PENDING" if outcome == "pending" else "FAILED"
    ctx.tx.add(
        GwWebhookDelivery(
            id=event_id,
            event=event,
            gw_payment_id=gw_payment_id,
            gw_refund_id=gw_refund_id,
            attempts=attempts,
            final_status=final_status,
            created_at=first_at,
            updated_at=last_at,
        )
    )
    # Our event log holds the same story as our consumer saw it. Retries here belong to the gateway (it was still
    # retrying, or gave up), so no retry of ours
    # is queued: exhausted deliveries are DEAD and wait for a person to replay them.
    last = attempts[-1]
    ctx.tx.add(
        WebhookEvent(
            id=event_id,
            event=event,
            gw_payment_id=gw_payment_id,
            gw_refund_id=gw_refund_id,
            payload={
                "id": event_id,
                "event": event,
                "gwPaymentId": gw_payment_id,
                "gwRefundId": gw_refund_id,
                "createdAt": to_iso(first_at),
            },
            status="PROCESSED" if outcome == "delivered" else "FAILED" if outcome == "pending" else "DEAD",
            attempts=[
                {
                    "at": a["at"],
                    "source": "GATEWAY",
                    "httpStatus": a["httpStatus"],
                    "outcome": "PROCESSED" if a["httpStatus"] is not None and a["httpStatus"] < 300 else "ERROR",  # type: ignore[operator]
                    "message": a["error"]
                    or ("Processed payment.captured" if event == "payment.captured" else "Processed refund.processed"),
                }
                for a in attempts
            ],
            attempt_count=len(attempts),
            last_http_status=last["httpStatus"],
            last_message=last["error"] or "Processed",
            next_retry_at=None,  # type: ignore[arg-type]
            first_received_at=first_at,
            updated_at=last_at,
        )
    )
    await ctx.tx.flush()
