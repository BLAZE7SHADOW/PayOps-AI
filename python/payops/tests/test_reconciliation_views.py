"""Matrix, candidates, lifecycle and settlement (a port of the matching packages/core reconciliation tests)."""

from dataclasses import replace
from datetime import timedelta

from payops.domain.gateway import WebhookAttempt
from payops.domain.reconciliation.candidates import (
    evaluate_order,
    group_hits,
    max_severity,
    priority_of,
    snapshot_entity_refs,
)
from payops.domain.reconciliation.lifecycle import build_lifecycle
from payops.domain.reconciliation.matrix import build_matrix
from payops.domain.reconciliation.rules import RuleHit
from payops.domain.reconciliation.settlement import check_batch
from payops.domain.timeutil import to_iso
from tests.factories import (
    DAY_MS,
    HOUR_MS,
    MINUTE_MS,
    ago,
    attempt,
    capture_journal,
    captured_order_failed_snapshot,
    delivery,
    gw_payment,
    gw_refund,
    healthy_snapshot,
    ledger_leg,
    merchant_row,
    order_row,
    payment_row,
    refund_row,
    settlement_line,
    settlement_row,
    transition,
    with_snapshot,
)


# ── matrix ──
def test_a_healthy_payment_has_no_mismatches() -> None:
    m = build_matrix(healthy_snapshot())
    assert m.mismatched == []
    g = m.cells["GATEWAY"]
    assert (g.status, g.amount_minor, g.reference, g.mismatch) == ("CAPTURED", 1_249_900, True, False)
    assert (m.cells["ORDER"].status, m.cells["ORDER"].detail, m.cells["ORDER"].reference) == (
        "PAID",
        "Internal payment CAPTURED",
        False,
    )
    assert (m.cells["LEDGER"].status, m.cells["LEDGER"].amount_minor) == ("POSTED", 1_249_900)
    assert (m.cells["WEBHOOK"].status, m.cells["WEBHOOK"].detail) == ("DELIVERED", "payment.captured")
    assert (m.cells["SETTLEMENT"].status, m.cells["SETTLEMENT"].detail) == ("SETTLED", "Batch stb_1")
    assert m.cells["SETTLEMENT"].amount_minor == 1_249_900 - 24_998 - 4_500


def test_captured_order_failed_flags_order_ledger_and_webhook() -> None:
    snap = captured_order_failed_snapshot()
    m = build_matrix(snap)
    assert m.mismatched == ["ORDER", "LEDGER", "WEBHOOK"]
    assert (m.cells["ORDER"].status, m.cells["ORDER"].detail) == ("FAILED", "Internal payment PENDING")
    assert (m.cells["LEDGER"].status, m.cells["LEDGER"].amount_minor, m.cells["LEDGER"].detail) == (
        "MISSING",
        None,
        "No capture credit for ₹12,499.00",
    )
    assert (m.cells["WEBHOOK"].status, m.cells["WEBHOOK"].detail) == ("HTTP 500 ×3", "payment.captured")
    assert m.cells["WEBHOOK"].at == snap.webhooks[0].attempts[2].at
    assert m.cells["SETTLEMENT"].status == "SETTLED"


def test_a_duplicate_capture_marks_the_gateway_cell() -> None:
    base = healthy_snapshot(499_900)
    second = gw_payment(id="gwp_2", amount_minor=499_900, captured_at=ago(26 * HOUR_MS - 120_000))
    m = build_matrix(with_snapshot(base, gateway=[*base.gateway, second]))
    c = m.cells["GATEWAY"]
    assert (c.status, c.amount_minor, c.mismatch, c.detail) == ("CAPTURED ×2", 999_800, True, "2 captures on one order")
    assert m.mismatched == ["GATEWAY"]


def test_paid_with_nothing_captured_is_flagged() -> None:
    m = build_matrix(
        with_snapshot(
            healthy_snapshot(), gateway=[gw_payment(status="FAILED", captured_at=None)], ledger=[], settlement_lines=[]
        )
    )
    assert m.cells["ORDER"].mismatch is True
    assert m.cells["LEDGER"].status == "NOT EXPECTED" and m.cells["SETTLEMENT"].status == "NOT EXPECTED"


def test_cancelled_orders_and_refunds() -> None:
    base = healthy_snapshot()
    order = order_row(
        status="CANCELLED",
        timeline=[*base.order.timeline, transition(ago(3 * DAY_MS), "PAID", "CANCELLED", "merchant")],
    )
    assert build_matrix(with_snapshot(base, order=order)).cells["ORDER"].mismatch is True

    small = healthy_snapshot(345_000)
    gw = gw_payment(amount_minor=345_000, status="REFUNDED", refunded_minor=345_000)
    m = build_matrix(
        with_snapshot(
            small,
            order=order_row(amount_minor=345_000, status="CANCELLED"),
            gateway=[gw],
            gw_refunds=[gw_refund()],
            refunds=[refund_row()],
        )
    )
    assert m.cells["ORDER"].mismatch is False
    assert m.cells["GATEWAY"].detail == "Refund ₹3,450.00 PROCESSED"
    assert (m.cells["LEDGER"].status, m.cells["LEDGER"].mismatch) == ("REFUND MISSING", True)


def test_webhook_cell_variants() -> None:
    base = healthy_snapshot()
    refund_hook = delivery(id="evt_2", event="refund.processed", fail=True, gw_refund_id="gwr_1")
    c = build_matrix(with_snapshot(base, webhooks=[*base.webhooks, refund_hook])).cells["WEBHOOK"]
    assert (c.status, c.detail, c.mismatch) == ("HTTP 500 ×3", "refund.processed", True)

    timeout = delivery(final_status="FAILED", attempts=[WebhookAttempt(to_iso(ago(HOUR_MS)), None, 30_000, "timeout")])
    assert build_matrix(with_snapshot(base, webhooks=[timeout])).cells["WEBHOOK"].status == "TIMEOUT ×1"

    pending = build_matrix(with_snapshot(base, webhooks=[delivery(final_status="PENDING")])).cells["WEBHOOK"]
    assert (pending.status, pending.mismatch) == ("PENDING", False)
    none = build_matrix(with_snapshot(base, webhooks=[])).cells["WEBHOOK"]
    assert (none.status, none.mismatch) == ("NONE", False)


def test_ledger_cell_variants() -> None:
    partial = build_matrix(with_snapshot(healthy_snapshot(), ledger=capture_journal(1_000_000))).cells["LEDGER"]
    assert (partial.status, partial.mismatch, partial.amount_minor) == ("PARTIAL", True, 1_000_000)
    base = healthy_snapshot()
    orphan = build_matrix(
        with_snapshot(base, gateway=[gw_payment(status="FAILED", captured_at=None)], settlement_lines=[])
    ).cells["LEDGER"]
    assert (orphan.status, orphan.mismatch) == ("PARTIAL", True)
    ledger = [*base.ledger, ledger_leg(id="led_r", refund_id="rfd_1", direction="DEBIT", amount_minor=1_000)]
    assert build_matrix(with_snapshot(base, ledger=ledger)).cells["LEDGER"].status == "POSTED"


def test_settlement_cell_variants() -> None:
    base = healthy_snapshot(1_180_000)
    line = settlement_line(base.gateway[0], base.merchant, fee_bps=300)
    m = build_matrix(with_snapshot(base, settlement_lines=[line]))
    c = m.cells["SETTLEMENT"]
    assert (c.status, c.mismatch, c.detail) == ("FEE MISMATCH", True, "Fee ₹417.72 vs contract ₹278.48")
    assert m.mismatched == ["SETTLEMENT"]
    pending = build_matrix(with_snapshot(healthy_snapshot(), settlement_lines=[], settlement=None)).cells["SETTLEMENT"]
    assert (pending.status, pending.mismatch) == ("PENDING", False)


def test_an_order_with_no_gateway_payment_at_all() -> None:
    m = build_matrix(
        with_snapshot(
            healthy_snapshot(),
            gateway=[],
            payment=payment_row(status="PENDING"),
            ledger=[],
            settlement_lines=[],
            webhooks=[],
        )
    )
    assert (m.cells["GATEWAY"].status, m.cells["GATEWAY"].reference) == (None, True)
    assert m.cells["ORDER"].mismatch is True and m.cells["LEDGER"].status == "NOT EXPECTED"


def test_matrix_serialises_to_the_wire_shape() -> None:
    js = build_matrix(healthy_snapshot()).to_json()
    assert js["mismatched"] == [] and js["cells"]["GATEWAY"]["amountMinor"] == 1_249_900  # type: ignore[index]


# ── candidates ──
def hit(**o) -> RuleHit:
    base = dict(
        rule_id="D1_CAPTURED_NOT_PAID",
        case_type="PAYMENT_MISMATCH",
        primary_entity=("payment", "pay_1"),
        amount_minor=100_000,
        reason="test",
    )
    return RuleHit(**{**base, **o})


CTX = ({"orderId": "ord_1"}, build_matrix(healthy_snapshot()))


def test_hits_on_one_case_type_and_entity_merge_into_one_candidate() -> None:
    out = group_hits(
        [hit(rule_id="D3_LEDGER_MISSING", severity_floor="MEDIUM", amount_minor=50_000), hit(), hit()], *CTX
    )
    assert len(out) == 1
    c = out[0]
    assert (c.fingerprint, c.type, c.rule_ids, c.amount_minor, c.severity) == (
        "PAYMENT_MISMATCH:pay_1",
        "PAYMENT_MISMATCH",
        ["D1_CAPTURED_NOT_PAID", "D3_LEDGER_MISSING"],
        100_000,
        "MEDIUM",
    )


def test_different_case_types_or_entities_stay_apart() -> None:
    out = group_hits(
        [hit(), hit(case_type="RISK_CASE", rule_id="D8_RISK_VELOCITY"), hit(primary_entity=("payment", "pay_2"))], *CTX
    )
    assert [c.fingerprint for c in out] == ["PAYMENT_MISMATCH:pay_1", "RISK_CASE:pay_1", "PAYMENT_MISMATCH:pay_2"]


def test_severity_is_the_higher_of_amount_band_and_rule_floor() -> None:
    assert group_hits([hit(amount_minor=99_900)], *CTX)[0].severity == "LOW"
    assert group_hits([hit(amount_minor=99_900, severity_floor="HIGH")], *CTX)[0].severity == "HIGH"
    assert group_hits([hit(amount_minor=7_800_000, severity_floor="MEDIUM")], *CTX)[0].severity == "CRITICAL"


def test_batch_cases_record_the_batch_id() -> None:
    out = group_hits(
        [hit(case_type="SETTLEMENT_MISMATCH", rule_id="D7_SETTLEMENT_DIFF", primary_entity=("batch", "stb_9"))], *CTX
    )
    assert out[0].entity_refs == {"orderId": "ord_1", "batchId": "stb_9"}


def test_priority_orders_by_severity_then_rupees() -> None:
    assert priority_of("HIGH", 1_249_900) == 2_012_499
    assert priority_of("CRITICAL", 1) > priority_of("HIGH", 100_000_000_000)
    assert priority_of("LOW", 100_000_000_000) == 999_999
    assert max_severity("LOW", None, "HIGH", "MEDIUM") == "HIGH" and max_severity() == "LOW"


def test_evaluate_order() -> None:
    r = evaluate_order(captured_order_failed_snapshot())
    assert len(r.candidates) == 1
    c = r.candidates[0]
    assert (c.fingerprint, c.rule_ids, c.severity) == (
        "PAYMENT_MISMATCH:pay_1",
        ["D1_CAPTURED_NOT_PAID", "D3_LEDGER_MISSING"],
        "HIGH",
    )
    assert c.entity_refs == {
        "paymentId": "pay_1",
        "gwPaymentId": "gwp_1",
        "orderId": "ord_1",
        "customerId": "cus_1",
        "merchantId": "mer_1",
        "batchId": "stb_1",
    }
    assert c.matrix.mismatched == ["ORDER", "LEDGER", "WEBHOOK"]
    assert evaluate_order(healthy_snapshot()).candidates == []


def test_duplicate_gateway_payments_are_listed() -> None:
    base = healthy_snapshot()
    s = with_snapshot(base, gateway=[*base.gateway, gw_payment(id="gwp_2", captured_at=ago(25 * HOUR_MS))])
    assert snapshot_entity_refs(s)["duplicateGwPaymentIds"] == ["gwp_2"]


# ── lifecycle ──
def test_lifecycle_merges_systems_in_time_order() -> None:
    events = build_lifecycle(healthy_snapshot())
    ats = [e.at for e in events]
    assert sorted(ats) == ats
    assert [f"{e.system}:{e.title}" for e in events] == [
        "ORDER:Order created",
        "GATEWAY:Gateway payment created",
        "GATEWAY:Captured ₹12,499.00 at gateway",
        "WEBHOOK:payment.captured delivered",
        "ORDER:Order PENDING to PAID",
        "LEDGER:Capture posted to ledger",
        "SETTLEMENT:Settled in batch stb_1",
    ]


def test_failed_webhook_attempts_show_status_and_latency() -> None:
    events = [e for e in build_lifecycle(captured_order_failed_snapshot()) if e.system == "WEBHOOK"]
    assert len(events) == 3
    assert (events[0].title, events[0].detail, events[0].tone) == (
        "payment.captured delivery failed",
        "Attempt 1 of 3 · HTTP 500 · 1,204 ms",
        "bad",
    )
    order = next(e for e in build_lifecycle(captured_order_failed_snapshot()) if e.title == "Order PENDING to FAILED")
    assert (order.tone, order.detail) == ("bad", "by checkout-timeout · No payment confirmation within 15 min")


def test_refunds_from_both_worlds_are_listed() -> None:
    s = with_snapshot(
        healthy_snapshot(),
        refunds=[refund_row()],
        gw_refunds=[gw_refund()],
        webhooks=[*healthy_snapshot().webhooks, delivery(id="evt_2", event="refund.processed", fail=True)],
    )
    titles = [e.title for e in build_lifecycle(s) if e.system == "REFUND"]
    assert titles == ["Refund requested", "Refund initiated at gateway", "Refund processed at gateway"]


def test_repeated_failed_attempts_become_one_risk_event() -> None:
    failed = [
        attempt(at=ago(26 * 60 * MINUTE_MS + (60 - i * 7) * MINUTE_MS), card_country=["IN", "US", "NG"][i % 3])
        for i in range(8)
    ]
    risk = [e for e in build_lifecycle(with_snapshot(healthy_snapshot(), recent_attempts=failed)) if e.system == "RISK"]
    assert len(risk) == 1
    assert (risk[0].title, risk[0].detail, risk[0].tone) == (
        "8 failed payment attempts in 49 min",
        "Card countries: IN, NG, US · Codes: CARD_DECLINED",
        "warn",
    )


def test_fewer_than_three_failures_make_no_risk_event() -> None:
    s = with_snapshot(healthy_snapshot(), recent_attempts=[attempt(), attempt()])
    assert not any(e.system == "RISK" for e in build_lifecycle(s))


def test_no_em_dashes_in_user_facing_text() -> None:
    s = with_snapshot(
        captured_order_failed_snapshot(), refunds=[refund_row(requested_at=ago(DAY_MS))], gw_refunds=[gw_refund()]
    )
    for e in build_lifecycle(s):
        assert "—" not in f"{e.title} {e.detail or ''}"


# ── settlement (D7) ──
MERCHANT = merchant_row()


def batch_lines(override: int | None = None):
    return [
        settlement_line(
            gw_payment(id=f"gwp_{i + 1}", amount_minor=amount),
            MERCHANT,
            fee_bps=300 if override == i else None,
            line_no=i + 1,
        )
        for i, amount in enumerate([500_000, 1_180_000, 250_000])
    ]


def test_a_batch_at_contract_rates_matches() -> None:
    r = check_batch("stb_1", batch_lines(), MERCHANT)
    assert (r.diff_minor, r.offending_lines, r.hit) == (0, [], None)
    assert r.expected_net_minor == r.reported_net_minor


def test_the_line_charged_above_contract_sizes_the_shortfall() -> None:
    r = check_batch("stb_1", batch_lines(1), MERCHANT)
    assert r.diff_minor == -13_924  # 300 vs 200 bps on ₹11,800: ₹118 extra fee plus ₹21.24 GST
    assert [o.line.gw_payment_id for o in r.offending_lines] == ["gwp_2"] and r.offending_lines[0].diff_minor == -13_924
    h = r.hit
    assert h is not None and (h.rule_id, h.case_type, h.severity_floor, h.primary_entity, h.amount_minor) == (
        "D7_SETTLEMENT_DIFF",
        "SETTLEMENT_MISMATCH",
        "MEDIUM",
        ("batch", "stb_1"),
        13_924,
    )
    assert h.reason == "Batch net is short by ₹139.24 across 1 line."


def test_over_settlement_and_empty_batch() -> None:
    a, b = batch_lines()[:2]
    r = check_batch("stb_1", [a, replace(b, net_minor=b.net_minor + 100)], MERCHANT)
    assert r.diff_minor == 100 and r.hit is not None and "over by ₹1.00" in r.hit.reason
    assert check_batch("stb_1", [], MERCHANT).hit is None
    assert settlement_row().id == "stb_1" and timedelta(0) == timedelta(0)
