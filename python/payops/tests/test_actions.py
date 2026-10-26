"""Action preconditions, postconditions, options and idempotency (a port of packages/core actions/actions.test.ts)."""

from typing import Any

from pydantic import TypeAdapter

from payops.db.models import Case, Dispute
from payops.domain.actions.facts import refundable_minor
from payops.domain.actions.idempotency import idempotency_key, stable_json
from payops.domain.actions.options import AttemptHistory, action_options
from payops.domain.actions.registry import postconditions_of, preconditions_of
from payops.domain.actions.types import BatchData, BatchState, CaseState
from payops.domain.reconciliation.matrix import build_matrix
from payops.domain.reconciliation.settlement import check_batch
from payops.domain.snapshot import OrderSnapshot
from payops.dto.actions import CatalogAction
from tests.factories import (
    DAY_MS,
    NOW,
    ago,
    capture_journal,
    captured_order_failed_snapshot,
    delivery,
    gw_payment,
    gw_refund,
    healthy_snapshot,
    merchant_row,
    payment_row,
    refund_row,
    settlement_line,
    settlement_row,
    with_snapshot,
)

ADAPTER: TypeAdapter[Any] = TypeAdapter(CatalogAction)


def act(type_: str, **params: Any) -> Any:
    return ADAPTER.validate_python({"type": type_, "params": params})


def case_row(**o: Any) -> Case:
    base: dict[str, Any] = dict(
        id="case_1", display_id="PAY-0001", fingerprint="PAYMENT_MISMATCH:pay_1", type="PAYMENT_MISMATCH", severity="HIGH", priority=1,
        status="OPEN", amount_minor=1_249_900, rule_ids=["D1_CAPTURED_NOT_PAID"], matrix={}, mismatched=[],
        entity_refs={"orderId": "ord_1", "paymentId": "pay_1", "gwPaymentId": "gwp_1"}, signals={}, assignee_id=None, due_at=None,
        active_run_id=None, resolution=None, last_detected_at=NOW, opened_at=NOW, resolved_at=None, updated_at=NOW,
    )
    return Case(**{**base, **o})


def state(order: OrderSnapshot | None, **o: Any) -> CaseState:
    return CaseState(**{**dict(now=NOW, case=case_row(), order=order, batch=None), **o})


def pre(a: Any, s: CaseState) -> list[str]:
    return preconditions_of(a, s)


def post(a: Any, s: CaseState) -> list[tuple[str, bool]]:
    return [(c.id, c.passed) for c in postconditions_of(a, s, 0)]


def reversed_ledger() -> list[Any]:
    return [*capture_journal(1_249_900), *(_flip(leg, i) for i, leg in enumerate(capture_journal(1_249_900, journal_id="jrn_r")))]


def _flip(leg: Any, i: int) -> Any:
    from copy import copy

    clone = copy(leg)
    clone.id = f"led_r{i}"
    clone.reversal_of = "led_c1" if i == 0 else "led_c2"
    clone.direction = "CREDIT" if leg.direction == "DEBIT" else "DEBIT"
    return clone


def _relabel(legs: list[Any], prefix: str) -> list[Any]:
    from copy import copy

    out = []
    for i, leg in enumerate(legs):
        clone = copy(leg)
        clone.id = f"{prefix}{i}"
        out.append(clone)
    return out


# ── REPLAY_WEBHOOK_EVENT ──
REPLAY = act("REPLAY_WEBHOOK_EVENT", eventId="evt_1")


def test_replay_needs_an_undelivered_event_of_this_case() -> None:
    assert pre(REPLAY, state(captured_order_failed_snapshot())) == []
    assert pre(REPLAY, state(healthy_snapshot())) == ["Event evt_1 (payment.captured) was already delivered."]
    assert "does not belong" in pre(act("REPLAY_WEBHOOK_EVENT", eventId="evt_other"), state(captured_order_failed_snapshot()))[0]
    assert len(pre(REPLAY, state(None))) == 1


def test_replay_passes_only_when_delivered_and_the_payment_mirrors_the_gateway() -> None:
    assert post(REPLAY, state(captured_order_failed_snapshot())) == [("a0.webhook.delivery", False), ("a0.payment.status", False)]
    assert post(REPLAY, state(healthy_snapshot())) == [("a0.webhook.delivery", True), ("a0.payment.status", True)]


# ── MARK_ORDER_PAID ──
MARK = act("MARK_ORDER_PAID", orderId="ord_1", paymentId="pay_1")


def test_mark_paid_needs_a_gateway_capture_and_an_unpaid_order() -> None:
    assert pre(MARK, state(captured_order_failed_snapshot())) == []
    assert pre(MARK, state(healthy_snapshot())) == ["Order ord_1 is already PAID."]
    failed_gw = with_snapshot(captured_order_failed_snapshot(), gateway=[gw_payment(status="FAILED", captured_at=None)])
    assert pre(MARK, state(failed_gw)) == ["The gateway shows gwp_1 as FAILED, not CAPTURED."]
    assert post(MARK, state(healthy_snapshot())) == [("a0.order.status", True), ("a0.order.paymentId", True)]
    assert post(MARK, state(captured_order_failed_snapshot()))[0] == ("a0.order.status", False)


# ── POST_LEDGER_ENTRY ──
POST = act("POST_LEDGER_ENTRY", paymentId="pay_1", amountMinor=1_249_900)


def test_post_ledger_refuses_a_second_credit_and_a_wrong_amount() -> None:
    assert pre(POST, state(captured_order_failed_snapshot())) == []
    assert pre(POST, state(healthy_snapshot())) == ["A capture credit of ₹12,499.00 is already posted for pay_1."]
    assert "does not match the gateway capture" in pre(act("POST_LEDGER_ENTRY", paymentId="pay_1", amountMinor=100), state(captured_order_failed_snapshot()))[0]


def test_post_ledger_wants_exactly_one_capture_journal_of_the_amount() -> None:
    assert post(POST, state(healthy_snapshot())) == [("a0.ledger.captureCredit", True)]
    assert post(POST, state(captured_order_failed_snapshot())) == [("a0.ledger.captureCredit", False)]
    second = _relabel(capture_journal(1_249_900, journal_id="jrn_2"), "led_d")
    twice = with_snapshot(healthy_snapshot(), ledger=[*capture_journal(1_249_900), *second])
    assert post(POST, state(twice)) == [("a0.ledger.captureCredit", False)]


# ── REVERSE_LEDGER_ENTRY ──
def test_reverse_needs_an_unreversed_journal_of_this_case() -> None:
    a = act("REVERSE_LEDGER_ENTRY", journalId="jrn_1")
    assert pre(a, state(healthy_snapshot())) == []
    after = with_snapshot(healthy_snapshot(), ledger=reversed_ledger())
    assert pre(a, state(after)) == ["Journal jrn_1 was already reversed by jrn_r."]
    assert "not on this case" in pre(act("REVERSE_LEDGER_ENTRY", journalId="jrn_zzz"), state(healthy_snapshot()))[0]


def test_reverse_as_an_undo_expects_zero_net_capture_credit() -> None:
    plain = act("REVERSE_LEDGER_ENTRY", journalId="jrn_1")
    undo = act("REVERSE_LEDGER_ENTRY", journalId="jrn_1", undoOf="res_abc123")
    after = with_snapshot(healthy_snapshot(), ledger=reversed_ledger())
    assert post(undo, state(after)) == [("a0.ledger.reversed", True), ("a0.ledger.netCapture", True)]
    # Without undoOf the original expectation holds: the net capture credit must still equal the gateway capture.
    assert post(plain, state(after)) == [("a0.ledger.reversed", True), ("a0.ledger.netCapture", False)]


# ── INITIATE_REFUND ──
def refund(amount: int) -> Any:
    return act("INITIATE_REFUND", gwPaymentId="gwp_1", amountMinor=amount, reason="Order cancelled")


def test_refund_is_capped_at_the_refundable_balance_counting_pending_refunds() -> None:
    s = healthy_snapshot()
    assert refundable_minor(s, "gwp_1") == 1_249_900
    assert pre(refund(1_249_900), state(s)) == []
    assert "more than the refundable balance of ₹12,499.00" in pre(refund(1_249_901), state(s))[0]
    pending = with_snapshot(s, gw_refunds=[gw_refund(amount_minor=200_000, status="PENDING", processed_at=None)])
    assert refundable_minor(pending, "gwp_1") == 1_049_900
    unsent = with_snapshot(s, refunds=[refund_row(amount_minor=49_900, status="REQUESTED", gw_refund_id=None)])
    assert refundable_minor(unsent, "gwp_1") == 1_200_000


def test_refund_refuses_payments_that_are_not_captured_or_not_on_this_order() -> None:
    refunded = with_snapshot(healthy_snapshot(), gateway=[gw_payment(status="REFUNDED", refunded_minor=1_249_900)])
    assert "is REFUNDED" in pre(refund(100), state(refunded))[0]
    assert "does not belong" in pre(act("INITIATE_REFUND", gwPaymentId="gwp_x", amountMinor=100, reason="x y z"), state(healthy_snapshot()))[0]


def test_refund_checks_the_gateway_refund_and_our_mirror() -> None:
    after = with_snapshot(
        healthy_snapshot(),
        gateway=[gw_payment(status="PARTIALLY_REFUNDED", refunded_minor=500_000)],
        gw_refunds=[gw_refund(amount_minor=500_000)],
        refunds=[refund_row(amount_minor=500_000, gw_refund_id="gwr_1", status="PROCESSED", reason="Order cancelled")],
    )
    assert post(refund(500_000), state(after)) == [("a0.refund.gateway", True), ("a0.refund.internal", True), ("a0.refund.balance", True)]
    assert [p for _, p in post(refund(500_000), state(healthy_snapshot()))] == [False, False, True]


# ── SYNC_REFUND_STATUS ──
SYNC = act("SYNC_REFUND_STATUS", refundId="rfd_1")


def stuck_snapshot() -> OrderSnapshot:
    return with_snapshot(healthy_snapshot(), refunds=[refund_row(gw_refund_id="gwr_1")], gw_refunds=[gw_refund()])


def test_sync_needs_a_linked_refund_whose_gateway_status_is_final() -> None:
    stuck = stuck_snapshot()
    assert pre(SYNC, state(stuck)) == []
    pending = with_snapshot(stuck, gw_refunds=[gw_refund(status="PENDING", processed_at=None)])
    assert pre(SYNC, state(pending)) == ["The gateway still shows refund gwr_1 as PENDING."]
    assert "never sent to the gateway" in pre(SYNC, state(with_snapshot(stuck, refunds=[refund_row(gw_refund_id=None)])))[0]
    assert pre(SYNC, state(with_snapshot(stuck, refunds=[refund_row(gw_refund_id="gwr_1", status="PROCESSED")]))) == ["Refund rfd_1 is already PROCESSED."]


def test_sync_checks_status_and_the_refund_journal() -> None:
    stuck = stuck_snapshot()
    assert post(SYNC, state(stuck)) == [("a0.refund.status", False), ("a0.ledger.refundJournal", False)]
    refund_leg = _relabel(capture_journal(345_000, journal_id="jrn_rf", refund_id="rfd_1"), "led_rf")
    synced = with_snapshot(stuck, refunds=[refund_row(gw_refund_id="gwr_1", status="PROCESSED")], ledger=[*capture_journal(1_249_900), *refund_leg])
    assert post(SYNC, state(synced)) == [("a0.refund.status", True), ("a0.ledger.refundJournal", True)]


# ── RAISE_SETTLEMENT_DISPUTE and D7 suppression ──
MERCHANT = merchant_row()
LINES = [settlement_line(gw_payment(), MERCHANT, fee_bps=300)]


def make_dispute(**o: Any) -> Dispute:
    base: dict[str, Any] = dict(
        id="dsp_1", type="SETTLEMENT", batch_id="stb_1", gw_payment_id="gwp_1", amount_minor=DIFF, status="OPEN", reason="short",
        resolution_id=None, created_at=NOW, updated_at=NOW,
    )
    return Dispute(**{**base, **o})


def batch(disputes: list[Dispute] | None = None) -> BatchState:
    data = BatchData(settlement=settlement_row(status="MISMATCH"), lines=LINES, merchant=MERCHANT, payments_by_gw={}, disputes=disputes or [])
    return BatchState(data, check_batch(data.settlement.id, data.lines, data.merchant, data.disputes))


DIFF = abs(batch().check.diff_minor)
DISPUTE_ACTION = act("RAISE_SETTLEMENT_DISPUTE", batchId="stb_1", amountMinor=DIFF, gwPaymentId="gwp_1")


def test_dispute_needs_a_mismatched_batch_the_exact_diff_and_no_open_dispute() -> None:
    assert pre(DISPUTE_ACTION, state(None, batch=batch())) == []
    wrong = act("RAISE_SETTLEMENT_DISPUTE", batchId="stb_1", amountMinor=DIFF + 1, gwPaymentId="gwp_1")
    assert "does not match the batch difference" in pre(wrong, state(None, batch=batch()))[0]
    assert pre(DISPUTE_ACTION, state(None, batch=batch([make_dispute()]))) == ["Batch stb_1 already has an open dispute (dsp_1)."]
    assert "not this case's settlement batch" in pre(DISPUTE_ACTION, state(None))[0]


def test_d7_is_suppressed_only_by_an_open_dispute_covering_exactly_the_diff() -> None:
    assert batch().check.hit.rule_id == "D7_SETTLEMENT_DIFF"
    covered = batch([make_dispute()]).check
    assert covered.hit is None and covered.dispute_id == "dsp_1"
    assert batch([make_dispute(amount_minor=DIFF - 1)]).check.hit is not None
    assert batch([make_dispute(status="LOST")]).check.hit is not None
    assert post(DISPUTE_ACTION, state(None, batch=batch([make_dispute()]))) == [("a0.dispute.open", True)]


# ── HOLD and ESCALATE ──
def test_hold_needs_the_case_payment_not_already_held() -> None:
    a = act("HOLD_PAYMENT_FOR_REVIEW", paymentId="pay_1")
    assert pre(a, state(healthy_snapshot())) == []
    held = with_snapshot(healthy_snapshot(), payment=payment_row(hold=True))
    assert pre(a, state(held)) == ["Payment pay_1 is already on hold."]
    assert post(a, state(held)) == [("a0.payment.hold", True)]


def test_escalate_is_always_allowed_and_checks_the_case_status() -> None:
    a = act("ESCALATE_TO_HUMAN", reason="Needs review", to="MANAGER")
    assert pre(a, state(None)) == []
    assert post(a, state(None, case=case_row(status="ESCALATED"))) == [("a0.case.status", True)]
    assert post(a, state(None)) == [("a0.case.status", False)]


# ── options ──
def test_options_offer_all_nine_actions_and_recommend_replay_for_a_captured_failed_order() -> None:
    options = action_options(state(captured_order_failed_snapshot()))
    assert len(options) == 9
    assert [o.type for o in options if o.recommended] == ["REPLAY_WEBHOOK_EVENT"]
    refund_option = next(o for o in options if o.type == "INITIATE_REFUND")
    assert (refund_option.editable, refund_option.max_amount_minor, refund_option.available) == (["amountMinor", "reason"], 1_249_900, True)
    sync = next(o for o in options if o.type == "SYNC_REFUND_STATUS")
    assert sync.available is False and sync.unavailable_reason
    assert all("—" not in o.summary for o in options)


def test_options_recommend_mark_paid_and_ledger_once_a_replay_failed() -> None:
    s = captured_order_failed_snapshot()
    history = [AttemptHistory(["REPLAY_WEBHOOK_EVENT"], "VALIDATED", "FAIL")]
    assert [o.type for o in action_options(state(s), history) if o.recommended] == ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"]
    s.order.locked_reason = "VERSION_CONFLICT"
    # `locked_reason` is simulator fault injection; a person could not see it, so it must not change advice.
    assert [o.type for o in action_options(state(s)) if o.recommended] == ["REPLAY_WEBHOOK_EVENT"]


def test_options_target_the_extra_capture_for_a_duplicate() -> None:
    dup = gw_payment(id="gwp_2", captured_at=ago(DAY_MS))
    s = with_snapshot(healthy_snapshot(), gateway=[gw_payment(), dup])
    options = action_options(state(s, case=case_row(type="DUPLICATE")))
    refund_option = next(o for o in options if o.type == "INITIATE_REFUND")
    assert refund_option.recommended is True
    assert refund_option.action.params.gw_payment_id == "gwp_2" and refund_option.action.params.amount_minor == 1_249_900
    assert refund_option.to_json()["action"]["params"]["gwPaymentId"] == "gwp_2"  # type: ignore[index]


# ── idempotency ──
def test_idempotency_key_is_stable_across_key_order_and_differs_by_resolution_index_and_params() -> None:
    a = act("INITIATE_REFUND", gwPaymentId="gwp_1", amountMinor=100, reason="x y z")
    reordered = act("INITIATE_REFUND", reason="x y z", amountMinor=100, gwPaymentId="gwp_1")
    assert stable_json({"b": 1, "a": {"d": None, "c": [2, "x"]}}) == '{"a":{"c":[2,"x"]},"b":1}'
    assert idempotency_key("rsl_1", 0, reordered) == idempotency_key("rsl_1", 0, a)
    assert len(idempotency_key("rsl_1", 0, a)) == 64
    assert idempotency_key("rsl_2", 0, a) != idempotency_key("rsl_1", 0, a)
    assert idempotency_key("rsl_1", 1, a) != idempotency_key("rsl_1", 0, a)
    assert idempotency_key("rsl_1", 0, act("INITIATE_REFUND", gwPaymentId="gwp_1", amountMinor=101, reason="x y z")) != idempotency_key("rsl_1", 0, a)


def test_a_failed_delivery_stops_being_a_mismatch_once_the_payment_record_caught_up() -> None:
    fixed = with_snapshot(healthy_snapshot(), webhooks=[delivery(fail=True)])
    cell = build_matrix(fixed).cells["WEBHOOK"]
    assert (cell.status, cell.mismatch) == ("HTTP 500 ×3", False)
    assert build_matrix(captured_order_failed_snapshot()).cells["WEBHOOK"].mismatch is True


def test_the_catalog_accepts_undo_of_and_rejects_bad_params() -> None:
    import pytest
    from pydantic import ValidationError

    assert act("REVERSE_LEDGER_ENTRY", journalId="jrn_1", undoOf="res_abc123").params.undo_of == "res_abc123"
    with pytest.raises(ValidationError):
        act("INITIATE_REFUND", gwPaymentId="gwp_1", amountMinor=0, reason="x y z")
    with pytest.raises(ValidationError):
        act("ESCALATE_TO_HUMAN", reason="x", to="MANAGER")


# ── validator (pure half) ──
def test_a_healthy_case_has_a_clean_matrix_but_detection_still_looks_for_the_fingerprint() -> None:
    from payops.domain.validation import case_invariants, verdict_of

    checks = case_invariants(state(healthy_snapshot()))
    assert [(c.id, c.passed) for c in checks] == [("inv.matrix", True), ("inv.detection", True)]
    assert verdict_of(checks) == "PASS"


def test_a_broken_case_fails_the_matrix_per_system_and_detection() -> None:
    from payops.domain.validation import case_invariants, verdict_of

    checks = case_invariants(state(captured_order_failed_snapshot()))
    assert [(c.id, c.passed) for c in checks] == [("inv.matrix.ORDER", False), ("inv.matrix.LEDGER", False), ("inv.matrix.WEBHOOK", False), ("inv.detection", False)]
    assert checks[1].actual == "MISSING: No capture credit for ₹12,499.00"
    assert "D1_CAPTURED_NOT_PAID" in checks[3].actual
    assert verdict_of(checks) == "PARTIAL"  # only invariants failed


def test_the_verdict_is_fail_when_any_postcondition_fails() -> None:
    from payops.domain.validation import case_invariants, verdict_of

    broken = state(captured_order_failed_snapshot())
    checks = [*postconditions_of(MARK, broken, 0), *case_invariants(broken)]
    assert verdict_of(checks) == "FAIL"
    assert verdict_of([]) == "PASS"


def test_an_open_dispute_lets_a_settlement_case_pass_with_only_settlement_differing() -> None:
    from payops.domain.validation import case_invariants

    base = healthy_snapshot(1_180_000)
    line = settlement_line(base.gateway[0], base.merchant, fee_bps=300)
    snap = with_snapshot(base, settlement_lines=[line])
    covered = state(snap, case=case_row(type="SETTLEMENT_MISMATCH", fingerprint="SETTLEMENT_MISMATCH:stb_1"), batch=batch([make_dispute()]))
    checks = case_invariants(covered)
    assert checks[0].id == "inv.matrix" and checks[0].passed and "covered by an open dispute" in checks[0].actual
