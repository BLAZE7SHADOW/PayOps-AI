"""Detection rules D1 to D8 (a port of packages/core reconciliation/rules.test.ts)."""

from datetime import timedelta

from payops.domain.reconciliation.rules import (
    d1_captured_not_paid,
    d2_paid_not_captured,
    d3_ledger_missing,
    d4_duplicate_capture,
    d5_refund_pending_sla,
    d6_refund_missing,
    d8_risk_velocity,
    run_order_rules,
)
from tests.factories import (
    DAY_MS,
    HOUR_MS,
    MINUTE_MS,
    ago,
    attempt,
    capture_journal,
    captured_order_failed_snapshot,
    gw_payment,
    healthy_snapshot,
    order_row,
    payment_row,
    refund_row,
    transition,
    with_snapshot,
)


def cancelled(cancel_ago_ms: float):
    base = healthy_snapshot(7_800_000)
    return with_snapshot(
        base,
        order=order_row(amount_minor=7_800_000, status="CANCELLED", timeline=[*base.order.timeline, transition(ago(cancel_ago_ms), "PAID", "CANCELLED", "merchant")]),
    )


def fresh_capture(captured_ago_ms: float):
    base = captured_order_failed_snapshot()
    return with_snapshot(base, gateway=[gw_payment(captured_at=ago(captured_ago_ms))], order=order_row(status="PENDING", timeline=[]))


def test_a_healthy_payment_fires_no_rule() -> None:
    assert run_order_rules(healthy_snapshot()) == []


def test_d1_fires_after_the_grace_period() -> None:
    hit = d1_captured_not_paid(captured_order_failed_snapshot())
    assert hit is not None
    assert (hit.rule_id, hit.case_type, hit.amount_minor, hit.primary_entity) == ("D1_CAPTURED_NOT_PAID", "PAYMENT_MISMATCH", 1_249_900, ("payment", "pay_1"))
    assert hit.reason == "Gateway captured ₹12,499.00 but the order is FAILED."


def test_d1_waits_ten_minutes() -> None:
    assert d1_captured_not_paid(fresh_capture(9 * MINUTE_MS)) is None
    assert d1_captured_not_paid(fresh_capture(11 * MINUTE_MS)) is not None


def test_d1_ignores_paid_cancelled_and_fully_refunded() -> None:
    assert d1_captured_not_paid(healthy_snapshot()) is None
    assert d1_captured_not_paid(cancelled(3 * DAY_MS)) is None
    refunded = gw_payment(status="REFUNDED", refunded_minor=1_249_900)
    assert d1_captured_not_paid(with_snapshot(captured_order_failed_snapshot(), gateway=[refunded])) is None


def test_d1_keys_on_the_gateway_id_without_an_internal_payment() -> None:
    hit = d1_captured_not_paid(with_snapshot(captured_order_failed_snapshot(), payment=None))
    assert hit is not None and hit.primary_entity == ("payment", "gwp_1")


def test_d2_paid_but_not_captured() -> None:
    s = with_snapshot(healthy_snapshot(), gateway=[gw_payment(status="FAILED", captured_at=None)], ledger=[])
    hit = d2_paid_not_captured(s)
    assert hit is not None and (hit.rule_id, hit.severity_floor, hit.amount_minor) == ("D2_PAID_NOT_CAPTURED", "HIGH", 1_249_900)
    assert d2_paid_not_captured(healthy_snapshot()) is None
    unpaid = with_snapshot(healthy_snapshot(), order=order_row(status="PENDING"), gateway=[gw_payment(status="CREATED", captured_at=None)])
    assert d2_paid_not_captured(unpaid) is None


def test_d3_ledger_missing() -> None:
    hit = d3_ledger_missing(captured_order_failed_snapshot())
    assert hit is not None and (hit.rule_id, hit.severity_floor, hit.amount_minor) == ("D3_LEDGER_MISSING", "MEDIUM", 1_249_900)
    partial = d3_ledger_missing(with_snapshot(healthy_snapshot(), ledger=capture_journal(1_000_000)))
    assert partial is not None and partial.amount_minor == 249_900
    assert d3_ledger_missing(healthy_snapshot()) is None
    young = with_snapshot(healthy_snapshot(), ledger=[], gateway=[gw_payment(captured_at=ago(5 * MINUTE_MS))])
    assert d3_ledger_missing(young) is None


def _dup():
    base = healthy_snapshot(499_900)
    return with_snapshot(base, gateway=[*base.gateway, gw_payment(id="gwp_2", amount_minor=499_900, captured_at=ago(26 * HOUR_MS - 2 * MINUTE_MS))])


def test_d4_duplicate_capture() -> None:
    hit = d4_duplicate_capture(_dup())
    assert hit is not None
    assert (hit.rule_id, hit.case_type, hit.severity_floor, hit.primary_entity, hit.amount_minor) == (
        "D4_DUPLICATE_CAPTURE", "DUPLICATE", "HIGH", ("order", "ord_1"), 499_900,
    )
    base = healthy_snapshot()
    failed_second = with_snapshot(base, gateway=[*base.gateway, gw_payment(id="gwp_2", status="FAILED", captured_at=None)])
    assert d4_duplicate_capture(failed_second) is None


def test_d4_stops_once_the_extra_capture_is_refunded() -> None:
    base = _dup()
    refunded = gw_payment(id="gwp_2", amount_minor=499_900, status="REFUNDED", refunded_minor=499_900)
    assert d4_duplicate_capture(with_snapshot(base, gateway=[base.gateway[0], refunded])) is None
    partly = gw_payment(id="gwp_2", amount_minor=499_900, status="PARTIALLY_REFUNDED", refunded_minor=100_000)
    hit = d4_duplicate_capture(with_snapshot(base, gateway=[base.gateway[0], partly]))
    assert hit is not None and hit.amount_minor == 399_900
    assert [h.rule_id for h in run_order_rules(_dup())] == ["D4_DUPLICATE_CAPTURE"]


def test_d5_refund_pending_beyond_sla() -> None:
    hit = d5_refund_pending_sla(with_snapshot(healthy_snapshot(), refunds=[refund_row(requested_at=ago(9 * DAY_MS))]))
    assert hit is not None and (hit.rule_id, hit.case_type, hit.severity_floor, hit.amount_minor) == ("D5_REFUND_PENDING_SLA", "REFUND_EXCEPTION", "MEDIUM", 345_000)
    assert hit.reason == "Refund of ₹3,450.00 has been PENDING for 9 days."
    assert d5_refund_pending_sla(with_snapshot(healthy_snapshot(), refunds=[refund_row(requested_at=ago(6 * DAY_MS))])) is None
    assert d5_refund_pending_sla(with_snapshot(healthy_snapshot(), refunds=[refund_row(status="PROCESSED")])) is None


def test_d6_refund_missing_on_a_cancelled_order() -> None:
    hit = d6_refund_missing(cancelled(3 * DAY_MS))
    assert hit is not None and (hit.rule_id, hit.case_type, hit.amount_minor, hit.primary_entity) == ("D6_REFUND_MISSING", "REFUND_EXCEPTION", 7_800_000, ("payment", "pay_1"))
    assert d6_refund_missing(cancelled(47 * HOUR_MS)) is None
    assert d6_refund_missing(with_snapshot(cancelled(3 * DAY_MS), refunds=[refund_row(amount_minor=7_800_000)])) is None
    full = gw_payment(amount_minor=7_800_000, status="REFUNDED", refunded_minor=7_800_000)
    assert d6_refund_missing(with_snapshot(cancelled(3 * DAY_MS), gateway=[full])) is None
    assert d6_refund_missing(healthy_snapshot()) is None


def _risky(failed_count: int, amount_minor: int = 4_500_000):
    base = healthy_snapshot(amount_minor)
    captured_at = base.primary_gw.captured_at
    countries = ["IN", "US", "NG"]
    failed = [attempt(at=captured_at - timedelta(minutes=60 - i * 6), card_country=countries[i % 3]) for i in range(failed_count)]
    return with_snapshot(base, recent_attempts=failed)


def test_d8_risk_velocity() -> None:
    hit = d8_risk_velocity(_risky(8))
    assert hit is not None and (hit.rule_id, hit.case_type, hit.severity_floor, hit.amount_minor) == ("D8_RISK_VELOCITY", "RISK_CASE", "HIGH", 4_500_000)
    assert hit.reason == "8 failed attempts across 3 card countries in 24h before a ₹45,000.00 capture."
    assert d8_risk_velocity(with_snapshot(_risky(8), payment=payment_row(amount_minor=4_500_000, hold=True))) is None
    assert d8_risk_velocity(_risky(4)) is None
    assert d8_risk_velocity(_risky(8, 999_900)) is None


def test_d8_ignores_failures_older_than_24_hours_or_after_the_capture() -> None:
    base = _risky(0)
    captured = base.primary_gw.captured_at
    outside = [*(attempt(at=captured - timedelta(hours=25)) for _ in range(3)), *(attempt(at=captured + timedelta(minutes=1)) for _ in range(3))]
    assert d8_risk_velocity(with_snapshot(base, recent_attempts=outside)) is None


def test_captured_order_failed_fires_d1_and_d3_on_the_same_payment() -> None:
    assert [h.rule_id for h in run_order_rules(captured_order_failed_snapshot())] == ["D1_CAPTURED_NOT_PAID", "D3_LEDGER_MISSING"]
    no_records = with_snapshot(healthy_snapshot(), gateway=[], payment=None, ledger=[])
    hit = d2_paid_not_captured(no_records)
    assert hit is not None and hit.primary_entity == ("order", "ord_1")
    assert run_order_rules(with_snapshot(healthy_snapshot(), payment=payment_row(status="PENDING"))) == []


def test_unused_constants_are_in_scope() -> None:
    assert HOUR_MS == 3_600_000
