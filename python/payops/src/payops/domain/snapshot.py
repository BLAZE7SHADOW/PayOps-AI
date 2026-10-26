"""Everything reconciliation needs to know about one order, loaded once and then read by pure functions (matrix, rules, lifecycle).

Nothing here is fetched lazily, so the same snapshot always produces the same verdicts, which is what makes the rules easy to test.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from ..db.models import Customer, Device, Dispute, LedgerEntry, Merchant, Order, Payment, PaymentAttempt, Refund, Settlement
from .gateway import GatewayPayment, GatewayRefund, GatewaySettlementLine, GatewayWebhookDelivery


@dataclass
class OrderSnapshot:
    #: The instant the checks are evaluated at.
    now: datetime
    order: Order
    #: Our internal payment for the order, if one was ever created.
    payment: Payment | None
    #: Every gateway payment whose order reference is this order (more than one means duplicates).
    gateway: list[GatewayPayment]
    #: The gateway payment the internal payment points at, else the first captured, else the first.
    primary_gw: GatewayPayment | None
    webhooks: list[GatewayWebhookDelivery]
    #: Ledger entries of the internal payment (capture and refund postings).
    ledger: list[LedgerEntry]
    refunds: list[Refund]
    gw_refunds: list[GatewayRefund]
    settlement_lines: list[GatewaySettlementLine]
    #: Internal settlement record for the primary payment's batch.
    settlement: Settlement | None
    merchant: Merchant
    customer: Customer
    #: The customer's attempts in the 24 hours before the primary capture (or before `now`).
    recent_attempts: list[PaymentAttempt]
    #: Devices this customer has been seen on, all time.
    devices: list[Device] = field(default_factory=list)
    #: Settlement disputes raised against this order's merchant in the risk window: a merchant-level exposure proxy.
    merchant_disputes: list[Dispute] = field(default_factory=list)


def pick_primary_gw(gateway: Sequence[GatewayPayment], payment: Payment | None) -> GatewayPayment | None:
    """Picks the gateway payment that represents "the" payment for an order."""
    if payment is not None:
        linked = next((g for g in gateway if g.id == payment.gw_payment_id), None)
        if linked is not None:
            return linked
    return next((g for g in gateway if g.status == "CAPTURED"), None) or (gateway[0] if gateway else None)
