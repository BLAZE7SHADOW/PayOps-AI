"""Detection rules D1 to D8 (docs/04-data-model.md, Detection rules). Each rule is a pure function of an OrderSnapshot and returns at
most one hit. D7 works on settlement batches and lives in settlement.py. Thresholds are named constants so tests and docs can point at them."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

from ..money import AMOUNT_BAND_THRESHOLDS_MINOR, format_money
from ..snapshot import OrderSnapshot
from ..timeutil import DAY_MS, HOUR_MS, MINUTE_MS, ms_between
from .facts import (
    PAID_ORDER_STATUSES,
    capture_credit_minor,
    captured_gw,
    captured_total_minor,
    gateway_refunded_minor,
    held_captures,
    is_captured,
    last_transition_at,
    ms_since,
    outstanding_captured_minor,
)


@dataclass(frozen=True)
class _Thresholds:
    #: Grace period before a capture without an order or ledger update is an exception.
    capture_grace_ms: int = 10 * MINUTE_MS
    refund_sla_ms: int = 7 * DAY_MS
    cancelled_refund_grace_ms: int = 48 * HOUR_MS
    risk_window_ms: int = 24 * HOUR_MS
    risk_min_failed_attempts: int = 5
    risk_min_capture_minor: int = AMOUNT_BAND_THRESHOLDS_MINOR["HIGH"]  # ₹10,000


RULE_THRESHOLDS: Final = _Thresholds()

EntityKind = Literal["payment", "order", "batch"]


@dataclass(frozen=True)
class RuleHit:
    rule_id: str
    case_type: str
    primary_entity: tuple[str, str]  # (kind, id)
    amount_minor: int
    #: One plain sentence explaining why the rule fired.
    reason: str
    #: Minimum severity regardless of amount.
    severity_floor: str | None = None

    @property
    def entity_kind(self) -> str:
        return self.primary_entity[0]

    @property
    def entity_id(self) -> str:
        return self.primary_entity[1]


OrderRule = Callable[[OrderSnapshot], RuleHit | None]


def _payment_entity(s: OrderSnapshot) -> tuple[str, str]:
    """Cases about a payment key on our internal payment id, or the gateway id if we never created one."""
    entity_id = s.payment.id if s.payment else (s.primary_gw.id if s.primary_gw else None)
    return ("payment", entity_id) if entity_id else ("order", s.order.id)


def _held_capture(s: OrderSnapshot):
    """First captured gateway payment still holding money, preferring the primary one."""
    held = held_captures(s)
    primary_id = s.primary_gw.id if s.primary_gw else None
    return next((g for g in held if g.id == primary_id), None) or (held[0] if held else None)


def d1_captured_not_paid(s: OrderSnapshot) -> RuleHit | None:
    gw = _held_capture(s)
    if gw is None or outstanding_captured_minor(s) == 0:
        return None
    if s.order.status in PAID_ORDER_STATUSES or s.order.status == "CANCELLED":
        return None
    if ms_since(s.now, gw.captured_at) <= RULE_THRESHOLDS.capture_grace_ms:
        return None
    return RuleHit(
        "D1_CAPTURED_NOT_PAID", "PAYMENT_MISMATCH", _payment_entity(s), gw.amount_minor,
        f"Gateway captured {format_money(gw.amount_minor)} but the order is {s.order.status}.",
    )


def d2_paid_not_captured(s: OrderSnapshot) -> RuleHit | None:
    if s.order.status not in PAID_ORDER_STATUSES or captured_gw(s):
        return None
    return RuleHit(
        "D2_PAID_NOT_CAPTURED", "PAYMENT_MISMATCH", _payment_entity(s), s.order.amount_minor,
        f"Order is {s.order.status} but the gateway shows {s.primary_gw.status if s.primary_gw else 'no payment'}.",
        severity_floor="HIGH",
    )


def d3_ledger_missing(s: OrderSnapshot) -> RuleHit | None:
    gw = s.primary_gw
    if gw is None or not is_captured(gw):
        return None
    credit = capture_credit_minor(s)
    if credit >= gw.amount_minor:
        return None
    if ms_since(s.now, gw.captured_at) <= RULE_THRESHOLDS.capture_grace_ms:
        return None
    return RuleHit(
        "D3_LEDGER_MISSING", "PAYMENT_MISMATCH", _payment_entity(s), gw.amount_minor - credit,
        f"Ledger capture credit is {format_money(credit)} for a {format_money(gw.amount_minor)} capture.",
        severity_floor="MEDIUM",
    )


def d4_duplicate_capture(s: OrderSnapshot) -> RuleHit | None:
    """Fires while more than one capture still holds money; refunding the extra capture resolves it."""
    captured = held_captures(s)
    if len(captured) <= 1:
        return None
    primary_id = s.primary_gw.id if s.primary_gw else None
    keep = next((g for g in captured if g.id == primary_id), captured[0])

    def held(g) -> int:
        return g.amount_minor - g.refunded_minor

    extra = sum(held(g) for g in captured) - held(keep)
    return RuleHit(
        "D4_DUPLICATE_CAPTURE", "DUPLICATE", ("order", s.order.id), extra,
        f"{len(captured)} captures recorded for one order; {format_money(extra)} captured more than once.",
        severity_floor="HIGH",
    )


def d5_refund_pending_sla(s: OrderSnapshot) -> RuleHit | None:
    stale = sorted(
        (r for r in s.refunds if r.status in ("REQUESTED", "PENDING") and ms_since(s.now, r.requested_at) > RULE_THRESHOLDS.refund_sla_ms),
        key=lambda r: r.requested_at,
    )
    if not stale:
        return None
    oldest = stale[0]
    days = int(ms_since(s.now, oldest.requested_at) // DAY_MS)
    return RuleHit(
        "D5_REFUND_PENDING_SLA", "REFUND_EXCEPTION", _payment_entity(s), oldest.amount_minor,
        f"Refund of {format_money(oldest.amount_minor)} has been {oldest.status} for {days} days.",
        severity_floor="MEDIUM",
    )


def d6_refund_missing(s: OrderSnapshot) -> RuleHit | None:
    if s.order.status != "CANCELLED":
        return None
    cancelled_at = last_transition_at(s.order, "CANCELLED")
    if cancelled_at is None or ms_between(s.now, cancelled_at) <= RULE_THRESHOLDS.cancelled_refund_grace_ms:
        return None
    captured = captured_total_minor(s)
    if captured == 0 or s.refunds:
        return None
    refunded = gateway_refunded_minor(s)
    if refunded >= captured:
        return None
    owed = captured - refunded
    return RuleHit(
        "D6_REFUND_MISSING", "REFUND_EXCEPTION", _payment_entity(s), owed,
        f"Order was cancelled but {format_money(owed)} captured has no refund.",
    )


def d8_risk_velocity(s: OrderSnapshot) -> RuleHit | None:
    """Suppressed once the payment is on hold: the risk has been contained and is with a person."""
    if s.payment is not None and s.payment.hold:
        return None
    gw = s.primary_gw
    if gw is None or not is_captured(gw) or gw.amount_minor < RULE_THRESHOLDS.risk_min_capture_minor:
        return None
    end = (gw.captured_at or s.now).timestamp() * 1000
    start = end - RULE_THRESHOLDS.risk_window_ms
    failed = [a for a in s.recent_attempts if a.result == "FAILED" and start <= a.at.timestamp() * 1000 < end]
    if len(failed) < RULE_THRESHOLDS.risk_min_failed_attempts:
        return None
    countries = {a.card_country for a in failed if a.card_country is not None}
    return RuleHit(
        "D8_RISK_VELOCITY", "RISK_CASE", _payment_entity(s), gw.amount_minor,
        f"{len(failed)} failed attempts across {len(countries)} card countries in 24h before a {format_money(gw.amount_minor)} capture.",
        severity_floor="HIGH",
    )


ORDER_RULES: Final[tuple[OrderRule, ...]] = (
    d1_captured_not_paid,
    d2_paid_not_captured,
    d3_ledger_missing,
    d4_duplicate_capture,
    d5_refund_pending_sla,
    d6_refund_missing,
    d8_risk_velocity,
)


def run_order_rules(s: OrderSnapshot) -> list[RuleHit]:
    return [hit for rule in ORDER_RULES if (hit := rule(s)) is not None]
