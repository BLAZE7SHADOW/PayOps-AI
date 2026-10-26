"""Snapshot builders for the domain tests, a port of packages/core reconciliation test-factory.ts.

`healthy_snapshot()` is a fully consistent order (captured, webhook delivered, order PAID, ledger posted, settled); tests then break one
thing at a time.
"""

from __future__ import annotations

import itertools
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

from payops.db.models import Customer, LedgerEntry, Merchant, Order, Payment, PaymentAttempt, Refund, Settlement
from payops.domain.gateway import (
    GatewayPayment,
    GatewayRefund,
    GatewaySettlementLine,
    GatewayWebhookDelivery,
    WebhookAttempt,
)
from payops.domain.money import bps_of
from payops.domain.snapshot import OrderSnapshot, pick_primary_gw
from payops.domain.timeutil import DAY_MS, HOUR_MS, MINUTE_MS, to_iso

NOW = datetime(2026, 9, 28, 12, 0, tzinfo=UTC)

__all__ = ["DAY_MS", "HOUR_MS", "MINUTE_MS", "NOW"]


def ago(ms: float) -> datetime:
    return NOW - timedelta(milliseconds=ms)


def _row(cls: type, defaults: dict[str, Any], overrides: dict[str, Any]) -> Any:
    return cls(**{**defaults, **overrides})


def merchant_row(**o: Any) -> Merchant:
    return _row(
        Merchant,
        dict(
            id="mer_1",
            name="Kavya Electronics",
            fee_bps=200,
            fee_fixed_minor=0,
            tax_bps=1800,
            settlement_cycle_days=1,
            created_at=ago(400 * DAY_MS),
            updated_at=ago(400 * DAY_MS),
        ),
        o,
    )


def customer_row(**o: Any) -> Customer:
    return _row(
        Customer,
        dict(
            id="cus_1",
            name="Aarav Sharma",
            email_masked="a****@gmail.com",
            phone_masked="+91 ******4321",
            risk_flags=[],
            created_at=ago(300 * DAY_MS),
            updated_at=ago(300 * DAY_MS),
        ),
        o,
    )


def transition(at: datetime, from_: str | None, to: str, by: str, reason: str | None = None) -> dict[str, Any]:
    return {"at": to_iso(at), "from": from_, "to": to, "by": by, "reason": reason}


def order_row(**o: Any) -> Order:
    created = o.get("created_at") or ago(26 * HOUR_MS + MINUTE_MS)
    return _row(
        Order,
        dict(
            id="ord_1",
            merchant_id="mer_1",
            customer_id="cus_1",
            amount_minor=1_249_900,
            status="PAID",
            payment_id="pay_1",
            version=1,
            locked_reason=None,
            timeline=[
                transition(created, None, "PENDING", "checkout"),
                transition(ago(26 * HOUR_MS - 2_000), "PENDING", "PAID", "webhook-consumer"),
            ],
            created_at=created,
            updated_at=created,
        ),
        o,
    )


def payment_row(**o: Any) -> Payment:
    return _row(
        Payment,
        dict(
            id="pay_1",
            gw_payment_id="gwp_1",
            order_id="ord_1",
            merchant_id="mer_1",
            customer_id="cus_1",
            amount_minor=1_249_900,
            method="CARD",
            status="CAPTURED",
            hold=False,
            recon=None,
            mismatch=False,
            created_at=ago(26 * HOUR_MS + MINUTE_MS),
            updated_at=ago(26 * HOUR_MS),
        ),
        o,
    )


def gw_payment(**o: Any) -> GatewayPayment:
    base = GatewayPayment(
        id="gwp_1",
        order_ref="ord_1",
        merchant_id="mer_1",
        amount_minor=1_249_900,
        status="CAPTURED",
        method="CARD",
        card={"last4": "4242", "network": "VISA", "country": "IN"},
        captured_at=ago(26 * HOUR_MS),
        refunded_minor=0,
        created_at=ago(26 * HOUR_MS + 30_000),
    )
    return replace(base, **o)


def delivery(fail: bool = False, **o: Any) -> GatewayWebhookDelivery:
    start = ago(26 * HOUR_MS - 1_000)
    if fail:
        attempts = [
            WebhookAttempt(to_iso(start + timedelta(minutes=5 * i)), 500, 1204 + i, "Internal Server Error")
            for i in range(3)
        ]
    else:
        attempts = [WebhookAttempt(to_iso(start), 200, 180, None)]
    base = GatewayWebhookDelivery(
        id="evt_1",
        event="payment.captured",
        gw_payment_id="gwp_1",
        gw_refund_id=None,
        attempts=attempts,
        final_status="FAILED" if fail else "DELIVERED",
        created_at=start,
    )
    return replace(base, **o)


def ledger_leg(**o: Any) -> LedgerEntry:
    return _row(
        LedgerEntry,
        dict(
            id="led_1",
            journal_id="jrn_1",
            payment_id="pay_1",
            refund_id=None,
            batch_id=None,
            merchant_id="mer_1",
            account="MERCHANT_PAYABLE",
            direction="CREDIT",
            amount_minor=1_249_900,
            posted_at=ago(26 * HOUR_MS - 3_000),
            source="SYSTEM",
            memo="capture",
            reversal_of=None,
        ),
        o,
    )


def capture_journal(amount_minor: int, **o: Any) -> list[LedgerEntry]:
    """Two-leg capture journal: DEBIT SETTLEMENT_CLEARING, CREDIT MERCHANT_PAYABLE."""
    return [
        ledger_leg(id="led_c1", account="SETTLEMENT_CLEARING", direction="DEBIT", amount_minor=amount_minor, **o),
        ledger_leg(id="led_c2", account="MERCHANT_PAYABLE", direction="CREDIT", amount_minor=amount_minor, **o),
    ]


def settlement_line(
    gw: GatewayPayment, merchant: Merchant, fee_bps: int | None = None, **o: Any
) -> GatewaySettlementLine:
    fee = bps_of(gw.amount_minor, fee_bps if fee_bps is not None else merchant.fee_bps) + merchant.fee_fixed_minor
    tax = bps_of(fee, merchant.tax_bps)
    base = GatewaySettlementLine(
        id=f"sln_{gw.id}",
        batch_id="stb_1",
        merchant_id="mer_1",
        gw_payment_id=gw.id,
        gross_minor=gw.amount_minor,
        fee_minor=fee,
        tax_minor=tax,
        net_minor=gw.amount_minor - fee - tax,
        line_no=1,
        settled_on=ago(2 * HOUR_MS),
    )
    return replace(base, **o)


def settlement_row(**o: Any) -> Settlement:
    return _row(
        Settlement,
        dict(
            id="stb_1",
            merchant_id="mer_1",
            settled_on=ago(2 * HOUR_MS),
            payment_ids=["pay_1"],
            expected_net_minor=0,
            reported_net_minor=0,
            status="PENDING",
            created_at=ago(2 * HOUR_MS),
            updated_at=ago(2 * HOUR_MS),
        ),
        o,
    )


def refund_row(**o: Any) -> Refund:
    return _row(
        Refund,
        dict(
            id="rfd_1",
            payment_id="pay_1",
            gw_payment_id="gwp_1",
            gw_refund_id=None,
            amount_minor=345_000,
            status="PENDING",
            reason="Customer returned item",
            requested_at=ago(9 * DAY_MS),
            created_at=ago(9 * DAY_MS),
            updated_at=ago(9 * DAY_MS),
        ),
        o,
    )


def gw_refund(**o: Any) -> GatewayRefund:
    base = GatewayRefund(
        id="gwr_1",
        gw_payment_id="gwp_1",
        amount_minor=345_000,
        status="PROCESSED",
        processed_at=ago(8 * DAY_MS),
        created_at=ago(9 * DAY_MS),
    )
    return replace(base, **o)


_attempt_seq = itertools.count(1)


def attempt(**o: Any) -> PaymentAttempt:
    return _row(
        PaymentAttempt,
        dict(
            id=f"att_{next(_attempt_seq)}",
            customer_id="cus_1",
            device_id="dev_1",
            order_id=None,
            amount_minor=4_500_000,
            result="FAILED",
            failure_code="CARD_DECLINED",
            card_country="IN",
            at=ago(27 * HOUR_MS),
        ),
        o,
    )


def healthy_snapshot(amount_minor: int = 1_249_900) -> OrderSnapshot:
    """A fully consistent, settled order paid by card."""
    merchant = merchant_row()
    gw = gw_payment(amount_minor=amount_minor)
    return OrderSnapshot(
        now=NOW,
        order=order_row(amount_minor=amount_minor),
        payment=payment_row(amount_minor=amount_minor),
        gateway=[gw],
        primary_gw=gw,
        webhooks=[delivery()],
        ledger=capture_journal(amount_minor),
        refunds=[],
        gw_refunds=[],
        settlement_lines=[settlement_line(gw, merchant)],
        settlement=settlement_row(),
        merchant=merchant,
        customer=customer_row(),
        recent_attempts=[attempt(result="SUCCESS", failure_code=None, at=ago(26 * HOUR_MS), order_id="ord_1")],
    )


_UNSET: Any = object()


def with_snapshot(base: OrderSnapshot, **patch: Any) -> OrderSnapshot:
    """A copy with fields replaced; recomputes the primary gateway payment unless given."""
    nxt = replace(base, **patch)
    if "primary_gw" not in patch:
        nxt.primary_gw = pick_primary_gw(nxt.gateway, nxt.payment)
    return nxt


def captured_order_failed_snapshot() -> OrderSnapshot:
    """The captured_order_failed shape: captured, webhook 500 three times, order FAILED, no ledger."""
    base = healthy_snapshot()
    created = base.order.created_at
    return with_snapshot(
        base,
        order=order_row(
            status="FAILED",
            timeline=[
                transition(created, None, "PENDING", "checkout"),
                transition(
                    created + timedelta(minutes=15),
                    "PENDING",
                    "FAILED",
                    "checkout-timeout",
                    "No payment confirmation within 15 min",
                ),
            ],
        ),
        payment=payment_row(status="PENDING"),
        webhooks=[delivery(fail=True)],
        ledger=[],
    )
