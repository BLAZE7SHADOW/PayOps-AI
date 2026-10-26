"""Preconditions and postconditions of the nine catalog actions (packages/core actions/handlers/*.ts).

Both are pure: preconditions say, in plain language, why an action cannot run on this data (empty means it can); postconditions are the checks
the validator runs on fresh data after execution.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

from ...dto.validation import ValidationCheck
from ..enums import REFUND_STATUS_FROM_GATEWAY
from ..ledger import live_capture_journals, summarize_journals
from ..money import format_money
from ..reconciliation.facts import CAPTURE_KNOWN_STATUSES, capture_credit_minor, is_captured
from ..reconciliation.settlement import covering_dispute
from .facts import NO_ORDER, refundable_minor
from .types import CaseState, postcondition

Pre = Callable[[Any, CaseState], list[str]]
Post = Callable[[Any, CaseState, int], list[ValidationCheck]]


def _http_label(status: int | None) -> str:
    return "no answer" if status is None else f"HTTP {status}"


# ── REPLAY_WEBHOOK_EVENT ─────────────────────────────────────────────────────
def replay_webhook_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    delivery = next((w for w in s.webhooks if w.id == p.event_id), None)
    if delivery is None:
        return [f"Event {p.event_id} does not belong to this case's payments."]
    if delivery.final_status == "DELIVERED":
        return [f"Event {p.event_id} ({delivery.event}) was already delivered."]
    gw = next((g for g in s.gateway if g.id == delivery.gw_payment_id), None)
    if delivery.event == "payment.captured" and not is_captured(gw):
        return [f"The gateway shows {delivery.gw_payment_id} as {gw.status if gw else 'missing'}, so replaying payment.captured would change nothing."]
    return []


def replay_webhook_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    s = state.order
    delivery = next((w for w in s.webhooks if w.id == p.event_id), None) if s else None
    last = delivery.attempts[-1] if delivery and delivery.attempts else None
    checks = [
        postcondition(
            index, "webhook.delivery", subject=f"webhook {p.event_id}", description="The replayed event was accepted by our consumer",
            expected="HTTP 2xx, DELIVERED",
            actual=f"{_http_label(last.http_status if last else None)}, {delivery.final_status}" if delivery else "event not found",
            passed=delivery is not None and delivery.final_status == "DELIVERED",
        )
    ]
    if s and delivery and delivery.event == "payment.captured":
        gw = next((g for g in s.gateway if g.id == delivery.gw_payment_id), None)
        internal = s.payment if s.payment and s.payment.gw_payment_id == delivery.gw_payment_id else None
        checks.append(
            postcondition(
                index, "payment.status", subject="payment.status", description="Our payment record matches the gateway",
                expected=gw.status if gw else "unknown", actual=internal.status if internal else "no internal payment",
                passed=gw is not None and internal is not None and internal.status == gw.status,
            )
        )
    if s and delivery and delivery.event.startswith("refund.") and delivery.gw_refund_id:
        gw_refund = next((r for r in s.gw_refunds if r.id == delivery.gw_refund_id), None)
        internal_refund = next((r for r in s.refunds if r.gw_refund_id == delivery.gw_refund_id), None)
        checks.append(
            postcondition(
                index, "refund.status", subject="refund.status", description="Our refund record matches the gateway",
                expected=gw_refund.status if gw_refund else "unknown", actual=internal_refund.status if internal_refund else "no internal refund",
                passed=gw_refund is not None and internal_refund is not None and internal_refund.status == gw_refund.status,
            )
        )
    return checks


# ── MARK_ORDER_PAID ──────────────────────────────────────────────────────────
def mark_order_paid_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    failures: list[str] = []
    if p.order_id != s.order.id:
        failures.append(f"Order {p.order_id} is not this case's order.")
    if s.payment is None or s.payment.id != p.payment_id:
        failures.append(f"Payment {p.payment_id} is not the internal payment of order {s.order.id}.")
    else:
        gw = next((g for g in s.gateway if g.id == s.payment.gw_payment_id), None)
        if gw is None or gw.status != "CAPTURED":
            failures.append(f"The gateway shows {s.payment.gw_payment_id} as {gw.status if gw else 'missing'}, not CAPTURED.")
    if s.order.status in ("PAID", "FULFILLED", "CANCELLED"):
        failures.append(f"Order {s.order.id} is already {s.order.status}.")
    return failures


def mark_order_paid_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    order = state.order.order if state.order else None
    return [
        postcondition(
            index, "order.status", subject="order.status", description="The order is paid", expected="PAID",
            actual=order.status if order else "order not found", passed=order is not None and order.status in ("PAID", "FULFILLED"),
        ),
        postcondition(
            index, "order.paymentId", subject="order.paymentId", description="The order points at the captured payment", expected=p.payment_id,
            actual=(order.payment_id or "not set") if order else "not set", passed=order is not None and order.payment_id == p.payment_id,
        ),
    ]


# ── POST_LEDGER_ENTRY ────────────────────────────────────────────────────────
def post_ledger_entry_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    if s.payment is None or s.payment.id != p.payment_id:
        return [f"Payment {p.payment_id} is not this case's payment."]
    failures: list[str] = []
    gw = next((g for g in s.gateway if g.id == s.payment.gw_payment_id), None)
    if gw is None or not is_captured(gw):
        failures.append(f"The gateway shows {s.payment.gw_payment_id} as {gw.status if gw else 'missing'}; only captured payments are posted.")
    elif p.amount_minor != gw.amount_minor:
        failures.append(f"Amount {format_money(p.amount_minor)} does not match the gateway capture of {format_money(gw.amount_minor)}.")
    credit = capture_credit_minor(s)
    if credit > 0:
        failures.append(f"A capture credit of {format_money(credit)} is already posted for {p.payment_id}.")
    return failures


def post_ledger_entry_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    entries = [e for e in (state.order.ledger if state.order else []) if e.payment_id == p.payment_id]
    journals = live_capture_journals(entries)

    class _L:
        ledger = entries

    credit = capture_credit_minor(_L())
    plural = "" if len(journals) == 1 else "s"
    return [
        postcondition(
            index, "ledger.captureCredit", subject="ledger.captureCredit", description="Exactly one capture credit equal to the captured amount",
            expected=f"1 journal, {format_money(p.amount_minor)}", actual=f"{len(journals)} journal{plural}, {format_money(credit)}",
            passed=len(journals) == 1 and credit == p.amount_minor,
        )
    ]


# ── REVERSE_LEDGER_ENTRY ─────────────────────────────────────────────────────
def reverse_ledger_entry_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    journal = next((j for j in summarize_journals(s.ledger) if j.journal_id == p.journal_id), None)
    if journal is None:
        return [f"Journal {p.journal_id} is not on this case's ledger."]
    if journal.kind == "REVERSAL":
        return [f"Journal {p.journal_id} is itself a reversal."]
    if journal.reversed_by:
        return [f"Journal {p.journal_id} was already reversed by {journal.reversed_by}."]
    return []


def reverse_ledger_entry_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    s = state.order
    journal = next((j for j in summarize_journals(s.ledger if s else []) if j.journal_id == p.journal_id), None)
    # An undo removes the capture credit on purpose, so nothing should remain (D070).
    if p.undo_of:
        expected = 0
    elif s and is_captured(s.primary_gw):
        expected = s.primary_gw.amount_minor if s.primary_gw else 0
    else:
        expected = 0
    actual = capture_credit_minor(s) if s else 0
    return [
        postcondition(
            index, "ledger.reversed", subject=f"journal {p.journal_id}", description="The journal has an equal and opposite reversal", expected="reversed",
            actual=f"reversed by {journal.reversed_by}" if journal and journal.reversed_by else "not reversed", passed=bool(journal and journal.reversed_by),
        ),
        postcondition(
            index, "ledger.netCapture", subject="ledger.captureCredit",
            description="No capture credit remains after the undo" if p.undo_of else "Net capture credit matches what the gateway captured",
            expected=format_money(expected), actual=format_money(actual), passed=actual == expected,
        ),
    ]


# ── INITIATE_REFUND ──────────────────────────────────────────────────────────
def initiate_refund_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    gw = next((g for g in s.gateway if g.id == p.gw_payment_id), None)
    if gw is None:
        return [f"Gateway payment {p.gw_payment_id} does not belong to this case's order."]
    if gw.status not in ("CAPTURED", "PARTIALLY_REFUNDED"):
        return [f"Gateway payment {gw.id} is {gw.status}; only captured payments can be refunded."]
    refundable = refundable_minor(s, gw.id)
    if p.amount_minor > refundable:
        return [f"{format_money(p.amount_minor)} is more than the refundable balance of {format_money(refundable)} on {gw.id}."]
    return []


def initiate_refund_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    s = state.order
    candidates = [r for r in (s.refunds if s else []) if r.gw_payment_id == p.gw_payment_id and r.amount_minor == p.amount_minor and r.reason == p.reason]
    internal = sorted(candidates, key=lambda r: r.requested_at, reverse=True)[0] if candidates else None
    gw_refund = next((r for r in s.gw_refunds if r.id == internal.gw_refund_id), None) if s and internal and internal.gw_refund_id else None
    gw = next((g for g in s.gateway if g.id == p.gw_payment_id), None) if s else None
    expected_internal = REFUND_STATUS_FROM_GATEWAY[gw_refund.status] if gw_refund else "a linked refund"
    return [
        postcondition(
            index, "refund.gateway", subject="gateway refund", description="The gateway has the refund, pending or processed, for the amount asked",
            expected=f"PENDING or PROCESSED, {format_money(p.amount_minor)}",
            actual=f"{gw_refund.status}, {format_money(gw_refund.amount_minor)}" if gw_refund else "no gateway refund",
            passed=gw_refund is not None and gw_refund.status != "FAILED" and gw_refund.amount_minor == p.amount_minor,
        ),
        postcondition(
            index, "refund.internal", subject="refund.status", description="Our refund record mirrors the gateway refund", expected=expected_internal,
            actual=f"{internal.status}{'' if internal.gw_refund_id else ', not linked'}" if internal else "no internal refund",
            passed=internal is not None and gw_refund is not None and internal.status == REFUND_STATUS_FROM_GATEWAY[gw_refund.status],
        ),
        postcondition(
            index, "refund.balance", subject="gateway refunded total", description="Refunds never exceed the captured amount",
            expected=f"at most {format_money(gw.amount_minor)}" if gw else "captured payment",
            actual=format_money(gw.refunded_minor) if gw else "payment not found", passed=gw is not None and gw.refunded_minor <= gw.amount_minor,
        ),
    ]


# ── SYNC_REFUND_STATUS ───────────────────────────────────────────────────────
def sync_refund_status_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    refund = next((r for r in s.refunds if r.id == p.refund_id), None)
    if refund is None:
        return [f"Refund {p.refund_id} is not on this case."]
    if refund.status == "PROCESSED":
        return [f"Refund {refund.id} is already PROCESSED."]
    if not refund.gw_refund_id:
        return [f"Refund {refund.id} was never sent to the gateway, so there is no status to copy."]
    gw = next((r for r in s.gw_refunds if r.id == refund.gw_refund_id), None)
    if gw is None:
        return [f"The gateway has no refund {refund.gw_refund_id}."]
    if gw.status == "PENDING":
        return [f"The gateway still shows refund {gw.id} as PENDING."]
    if REFUND_STATUS_FROM_GATEWAY[gw.status] == refund.status:
        return [f"Refund {refund.id} already matches the gateway ({gw.status})."]
    return []


def sync_refund_status_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    s = state.order
    refund = next((r for r in s.refunds if r.id == p.refund_id), None) if s else None
    gw = next((r for r in s.gw_refunds if r.id == refund.gw_refund_id), None) if s and refund and refund.gw_refund_id else None
    expected = REFUND_STATUS_FROM_GATEWAY[gw.status] if gw else "gateway status"
    checks = [
        postcondition(
            index, "refund.status", subject="refund.status", description="Our refund status equals the gateway refund status", expected=expected,
            actual=refund.status if refund else "refund not found", passed=refund is not None and gw is not None and refund.status == expected,
        )
    ]
    if gw is not None and gw.status == "PROCESSED":
        posted = any(
            j.kind == "REFUND" and j.reversed_by is None and j.legs and j.legs[0].refund_id == p.refund_id
            for j in summarize_journals(s.ledger if s else [])
        )
        checks.append(
            postcondition(
                index, "ledger.refundJournal", subject="ledger.refund", description="The processed refund is posted to the ledger",
                expected="refund journal posted", actual="refund journal posted" if posted else "no refund journal", passed=posted,
            )
        )
    return checks


# ── RAISE_SETTLEMENT_DISPUTE ─────────────────────────────────────────────────
def raise_settlement_dispute_pre(p: Any, state: CaseState) -> list[str]:
    b = state.batch
    if b is None or b.data.settlement.id != p.batch_id:
        return [f"Batch {p.batch_id} is not this case's settlement batch."]
    failures: list[str] = []
    diff = b.check.diff_minor
    if diff == 0 or b.data.settlement.status != "MISMATCH":
        failures.append(f"Batch {p.batch_id} is {b.data.settlement.status}; there is no difference to dispute.")
    elif p.amount_minor != abs(diff):
        failures.append(f"Amount {format_money(p.amount_minor)} does not match the batch difference of {format_money(abs(diff))}.")
    open_dispute = next((d for d in b.data.disputes if d.status == "OPEN"), None)
    if open_dispute:
        failures.append(f"Batch {p.batch_id} already has an open dispute ({open_dispute.id}).")
    if p.gw_payment_id and not any(line.gw_payment_id == p.gw_payment_id for line in b.data.lines):
        failures.append(f"Payment {p.gw_payment_id} is not in batch {p.batch_id}.")
    return failures


def raise_settlement_dispute_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    b = state.batch
    covering = covering_dispute(b.data.disputes, b.check.diff_minor) if b else None
    open_dispute = next((d for d in b.data.disputes if d.status == "OPEN"), None) if b else None
    shown = abs(b.check.diff_minor) if b else p.amount_minor
    return [
        postcondition(
            index, "dispute.open", subject=f"batch {p.batch_id}", description="An open dispute covers the settlement difference",
            expected=f"OPEN dispute for {format_money(shown)}",
            actual=f"{open_dispute.status} dispute for {format_money(open_dispute.amount_minor)}" if open_dispute else "no open dispute",
            passed=covering is not None,
        )
    ]


# ── HOLD_PAYMENT_FOR_REVIEW ──────────────────────────────────────────────────
def hold_payment_pre(p: Any, state: CaseState) -> list[str]:
    s = state.order
    if s is None:
        return [NO_ORDER]
    if s.payment is None or s.payment.id != p.payment_id:
        return [f"Payment {p.payment_id} is not this case's payment."]
    if s.payment.hold:
        return [f"Payment {p.payment_id} is already on hold."]
    return []


def hold_payment_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    payment = state.order.payment if state.order else None
    return [
        postcondition(
            index, "payment.hold", subject="payment.hold", description="The payment is frozen for review", expected="true",
            actual=str(payment.hold).lower() if payment and payment.id == p.payment_id else "payment not found",
            passed=payment is not None and payment.id == p.payment_id and payment.hold,
        )
    ]


# ── ESCALATE_TO_HUMAN ────────────────────────────────────────────────────────
def escalate_pre(p: Any, state: CaseState) -> list[str]:
    return []


def escalate_post(p: Any, state: CaseState, index: int) -> list[ValidationCheck]:
    return [
        postcondition(
            index, "case.status", subject="case.status", description="The case is with a person", expected="ESCALATED",
            actual=state.case.status, passed=state.case.status == "ESCALATED",
        )
    ]


PRECONDITIONS: Final[dict[str, Pre]] = {
    "REPLAY_WEBHOOK_EVENT": replay_webhook_pre,
    "MARK_ORDER_PAID": mark_order_paid_pre,
    "POST_LEDGER_ENTRY": post_ledger_entry_pre,
    "REVERSE_LEDGER_ENTRY": reverse_ledger_entry_pre,
    "INITIATE_REFUND": initiate_refund_pre,
    "SYNC_REFUND_STATUS": sync_refund_status_pre,
    "RAISE_SETTLEMENT_DISPUTE": raise_settlement_dispute_pre,
    "HOLD_PAYMENT_FOR_REVIEW": hold_payment_pre,
    "ESCALATE_TO_HUMAN": escalate_pre,
}
POSTCONDITIONS: Final[dict[str, Post]] = {
    "REPLAY_WEBHOOK_EVENT": replay_webhook_post,
    "MARK_ORDER_PAID": mark_order_paid_post,
    "POST_LEDGER_ENTRY": post_ledger_entry_post,
    "REVERSE_LEDGER_ENTRY": reverse_ledger_entry_post,
    "INITIATE_REFUND": initiate_refund_post,
    "SYNC_REFUND_STATUS": sync_refund_status_post,
    "RAISE_SETTLEMENT_DISPUTE": raise_settlement_dispute_post,
    "HOLD_PAYMENT_FOR_REVIEW": hold_payment_post,
    "ESCALATE_TO_HUMAN": escalate_post,
}

# `CAPTURE_KNOWN_STATUSES` is used by the mark-paid executor (services layer); re-exported here so both layers read one definition.
__all__ = ["CAPTURE_KNOWN_STATUSES", "POSTCONDITIONS", "PRECONDITIONS"]
