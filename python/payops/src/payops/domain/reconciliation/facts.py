"""Small derived facts over an OrderSnapshot. Every rule and matrix cell is built from these, so "what counts as captured" or
"what the contract fee is" is decided in exactly one place."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol

from ...db.models import LedgerEntry, Merchant, Order
from ..gateway import GatewayPayment, GatewayRefund
from ..money import bps_of
from ..timeutil import ms_between, parse_iso

#: A gateway payment that was captured at some point, even if it was later refunded.
CAPTURED_ONCE: Final = frozenset({"CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"})
PAID_ORDER_STATUSES: Final = frozenset({"PAID", "FULFILLED"})
#: Internal payment statuses that mean our records already know about the capture.
CAPTURE_KNOWN_STATUSES: Final = frozenset({"CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"})


class HasGateway(Protocol):
    @property
    def gateway(self) -> Sequence[GatewayPayment]: ...


class HasLedger(Protocol):
    @property
    def ledger(self) -> Sequence[LedgerEntry]: ...


class HasGwRefunds(Protocol):
    @property
    def gw_refunds(self) -> Sequence[GatewayRefund]: ...


def is_captured(gw: GatewayPayment | None) -> bool:
    return gw is not None and gw.status in CAPTURED_ONCE


def captured_gw(s: HasGateway) -> list[GatewayPayment]:
    return [g for g in s.gateway if is_captured(g)]


def held_captures(s: HasGateway) -> list[GatewayPayment]:
    """Captured gateway payments still holding customer money (not fully refunded). A duplicate capture refunded in full no longer counts."""
    return [g for g in captured_gw(s) if g.amount_minor > g.refunded_minor]


def captured_total_minor(s: HasGateway) -> int:
    return sum(g.amount_minor for g in captured_gw(s))


def gateway_refunded_minor(s: HasGateway) -> int:
    """What the gateway says it has refunded across the order's captured payments."""
    return sum(g.refunded_minor for g in captured_gw(s))


def outstanding_captured_minor(s: HasGateway) -> int:
    """Captured money the customer has not been given back (by the gateway's account)."""
    return max(0, captured_total_minor(s) - gateway_refunded_minor(s))


def capture_credit_minor(s: HasLedger) -> int:
    """Net capture credit on MERCHANT_PAYABLE for the internal payment, excluding refund postings."""
    total = 0
    for e in s.ledger:
        if e.account != "MERCHANT_PAYABLE" or e.refund_id is not None:
            continue
        total += e.amount_minor if e.direction == "CREDIT" else -e.amount_minor
    return total


def refund_posted_minor(s: HasLedger) -> int:
    """Refund money posted to the ledger (DEBIT MERCHANT_PAYABLE tagged with a refund)."""
    return sum(e.amount_minor for e in s.ledger if e.account == "MERCHANT_PAYABLE" and e.refund_id is not None and e.direction == "DEBIT")


def gateway_processed_refund_minor(s: HasGwRefunds) -> int:
    """Refund money the gateway reports as PROCESSED for the order."""
    return sum(r.amount_minor for r in s.gw_refunds if r.status == "PROCESSED")


@dataclass(frozen=True)
class FeeBreakdown:
    fee_minor: int
    tax_minor: int
    net_minor: int


class FeeTerms(Protocol):
    @property
    def fee_bps(self) -> int: ...
    @property
    def fee_fixed_minor(self) -> int: ...
    @property
    def tax_bps(self) -> int: ...


def expected_fee(gross_minor: int, merchant: FeeTerms | Merchant) -> FeeBreakdown:
    """What the merchant contract says a settlement line for `gross_minor` should look like."""
    fee = bps_of(gross_minor, merchant.fee_bps) + merchant.fee_fixed_minor
    tax = bps_of(fee, merchant.tax_bps)
    return FeeBreakdown(fee, tax, gross_minor - fee - tax)


def last_transition_at(order: Order, to: str) -> datetime | None:
    """When the order last moved into `to`, or None if it never did."""
    timeline: list[dict[str, Any]] = order.timeline
    for transition in reversed(timeline):
        if transition["to"] == to:
            return parse_iso(transition["at"])
    return None


def total(values: Iterable[int]) -> int:
    return sum(values)


def ms_since(now: datetime, then: datetime | None) -> float:
    return ms_between(now, then) if then is not None else 0
