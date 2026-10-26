"""Action options for the manual "Resolve" form: every catalog action with parameters prefilled for this case, whether
it can run now (from its preconditions), and which ones we recommend for the case's shape. Unavailable options still
carry a well-formed action with placeholder ids. (packages/core actions/options.ts)"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from pydantic import TypeAdapter

from ...dto.actions import ACTION_META, ACTION_TYPES, CatalogAction
from ...dto.validation import ActionOption
from ..enums import CASE_TYPE_LABEL
from ..ledger import live_capture_journals, summarize_journals
from ..money import format_money
from ..reconciliation.facts import (
    PAID_ORDER_STATUSES,
    capture_credit_minor,
    held_captures,
    is_captured,
    last_transition_at,
)
from ..reconciliation.rules import d8_risk_velocity
from ..snapshot import OrderSnapshot
from .facts import refundable_minor
from .registry import preconditions_of
from .types import CaseState

_ACTION: TypeAdapter[Any] = TypeAdapter(CatalogAction)
NONE: Final = "none"

#: Plain reason when the case has nothing for the action to act on (params hold the NONE placeholder).
MISSING_SUBJECT: Final = {
    "REPLAY_WEBHOOK_EVENT": "No webhook event on this case to replay.",
    "MARK_ORDER_PAID": "No order and captured payment on this case.",
    "POST_LEDGER_ENTRY": "No internal payment on this case to post.",
    "REVERSE_LEDGER_ENTRY": "No ledger journal on this case to reverse.",
    "INITIATE_REFUND": "No captured gateway payment on this case to refund.",
    "SYNC_REFUND_STATUS": "No refund on this case to sync.",
    "RAISE_SETTLEMENT_DISPUTE": "No settlement batch on this case.",
    "HOLD_PAYMENT_FOR_REVIEW": "No internal payment on this case to hold.",
    "ESCALATE_TO_HUMAN": "Escalation is not possible here.",
}


@dataclass(frozen=True)
class AttemptHistory:
    """What earlier attempts on the case did, for recommendations."""

    action_types: list[str]
    status: str
    verdict: str | None


@dataclass
class Draft:
    action: Any
    summary: str
    editable: list[str] = field(default_factory=list)
    max_amount_minor: int | None = None


def _make(type_: str, **params: Any) -> Any:
    return _ACTION.validate_python({"type": type_, "params": params})


def _missing_subject(action: Any) -> str | None:
    values = action.params.model_dump().values()
    return MISSING_SUBJECT[action.type] if NONE in values else None


def _replay_candidate(s: OrderSnapshot):
    undelivered = [w for w in s.webhooks if w.final_status != "DELIVERED"]
    primary_id = s.primary_gw.id if s.primary_gw else None
    return (
        next((w for w in undelivered if w.event == "payment.captured" and w.gw_payment_id == primary_id), None)
        or next((w for w in undelivered if w.event.startswith("refund.")), None)
        or (undelivered[0] if undelivered else None)
    )


def _refund_target(state: CaseState):
    """The gateway payment a refund should target: the extra capture for duplicates, else the primary."""
    s = state.order
    if s is None:
        return None
    if state.case.type == "DUPLICATE":
        linked = s.payment.gw_payment_id if s.payment else None
        extra = next((g for g in held_captures(s) if g.id != linked), None)
        if extra:
            return extra
    return s.primary_gw


def _refund_reason(state: CaseState) -> str:
    s = state.order
    if s is None:
        return "Refund requested by operations"
    if state.case.type == "DUPLICATE":
        return f"Duplicate capture on order {s.order.id}"
    if s.order.status == "CANCELLED":
        cancel = next((t for t in reversed(s.order.timeline) if t["to"] == "CANCELLED"), None)
        suffix = f": {cancel['reason']}" if cancel and cancel.get("reason") else ""
        return f"Order {s.order.id} cancelled{suffix}"[:200]
    return f"Refund requested by operations for order {s.order.id}"


def _escalate_reason(state: CaseState) -> str:
    s = state.order
    if state.case.type == "RISK_CASE" and s:
        from dataclasses import replace

        unheld = replace(s, payment=_without_hold(s.payment)) if s.payment else s
        hit = d8_risk_velocity(unheld)
        if hit:
            return f"{hit.reason} Needs a risk review."
    return f"Needs a person to review this {CASE_TYPE_LABEL[state.case.type].lower()} case"


def _without_hold(payment: Any) -> Any:
    from copy import copy

    clone = copy(payment)
    clone.hold = False
    return clone


def _draft_replay(state: CaseState) -> Draft:
    w = _replay_candidate(state.order) if state.order else None
    first = state.order.webhooks[0].id if state.order and state.order.webhooks else NONE
    return Draft(
        _make("REPLAY_WEBHOOK_EVENT", eventId=w.id if w else first),
        f"Replay {w.event} ({w.id}) to our webhook consumer" if w else "Replay a webhook event to our consumer",
    )


def _draft_mark_paid(state: CaseState) -> Draft:
    s = state.order
    order_id = s.order.id if s else (state.case.entity_refs.get("orderId") or NONE)
    payment_id = s.payment.id if s and s.payment else NONE
    gw = s.primary_gw if s else None
    gateway = f" (gateway captured {format_money(gw.amount_minor)})" if gw and is_captured(gw) else ""
    return Draft(
        _make("MARK_ORDER_PAID", orderId=order_id, paymentId=payment_id),
        f"Mark order {order_id} PAID and link payment {payment_id}{gateway}",
    )


def _draft_post_ledger(state: CaseState) -> Draft:
    s = state.order
    payment_id = s.payment.id if s and s.payment else NONE
    gw = None
    if s:
        gw = next((g for g in s.gateway if s.payment and g.id == s.payment.gw_payment_id), None) or s.primary_gw
    amount = max(1, gw.amount_minor if gw else 1)
    return Draft(
        _make("POST_LEDGER_ENTRY", paymentId=payment_id, amountMinor=amount),
        f"Post capture of {format_money(amount)} for {payment_id}: debit settlement clearing, credit merchant payable",
    )


def _draft_reverse_ledger(state: CaseState) -> Draft:
    ledger = state.order.ledger if state.order else []
    live = live_capture_journals(ledger)
    journal = (
        live[-1]
        if live
        else next((j for j in summarize_journals(ledger) if j.kind != "REVERSAL" and not j.reversed_by), None)
    )
    return Draft(
        _make("REVERSE_LEDGER_ENTRY", journalId=journal.journal_id if journal else NONE),
        f"Reverse {journal.kind.lower()} journal {journal.journal_id} ({format_money(journal.amount_minor)}) with an equal and opposite entry"
        if journal
        else "Reverse a ledger journal",
    )


def _draft_refund(state: CaseState) -> Draft:
    gw = _refund_target(state)
    refundable = refundable_minor(state.order, gw.id) if gw and state.order else 0
    amount = max(1, refundable)
    return Draft(
        _make("INITIATE_REFUND", gwPaymentId=gw.id if gw else NONE, amountMinor=amount, reason=_refund_reason(state)),
        f"Refund {format_money(amount)} to the customer on {gw.id}" if gw else "Refund the customer",
        editable=["amountMinor", "reason"],
        max_amount_minor=refundable,
    )


def _draft_sync_refund(state: CaseState) -> Draft:
    s = state.order
    refund = (
        (
            next((r for r in s.refunds if r.status != "PROCESSED" and r.gw_refund_id), None)
            or (s.refunds[0] if s.refunds else None)
        )
        if s
        else None
    )
    gw = (
        next((r for r in s.gw_refunds if r.id == refund.gw_refund_id), None)
        if s and refund and refund.gw_refund_id
        else None
    )
    if refund and gw:
        tail = " and post it to the ledger" if gw.status == "PROCESSED" else ""
        summary = f"Copy gateway status {gw.status} of {gw.id} to refund {refund.id}{tail}"
    else:
        summary = "Copy the gateway refund status to our refund record"
    return Draft(_make("SYNC_REFUND_STATUS", refundId=refund.id if refund else NONE), summary)


def _draft_dispute(state: CaseState) -> Draft:
    b = state.batch
    diff = b.check.diff_minor if b else 0
    amount = max(1, abs(diff))
    batch_id = b.data.settlement.id if b else (state.case.entity_refs.get("batchId") or NONE)
    gw_payment_id = b.check.offending_lines[0].line.gw_payment_id if b and b.check.offending_lines else None
    params: dict[str, Any] = {"batchId": batch_id, "amountMinor": amount}
    if gw_payment_id:
        params["gwPaymentId"] = gw_payment_id
    summary = (
        f"Raise a dispute for {format_money(amount)} {'short' if diff < 0 else 'over'} on batch {batch_id}"
        if diff != 0
        else f"Raise a settlement dispute on batch {batch_id}"
    )
    return Draft(_make("RAISE_SETTLEMENT_DISPUTE", **params), summary)


def _draft_hold(state: CaseState) -> Draft:
    p = state.order.payment if state.order else None
    return Draft(
        _make("HOLD_PAYMENT_FOR_REVIEW", paymentId=p.id if p else NONE),
        f"Hold payment {p.id} ({format_money(p.amount_minor)}) from payouts for review"
        if p
        else "Hold the payment for review",
    )


def _draft_escalate(state: CaseState) -> Draft:
    return Draft(
        _make("ESCALATE_TO_HUMAN", reason=_escalate_reason(state), to="MANAGER"),
        f"Escalate {state.case.display_id} to a manager with the reason attached",
        editable=["reason"],
    )


DRAFTERS: Final[dict[str, Callable[[CaseState], Draft]]] = {
    "REPLAY_WEBHOOK_EVENT": _draft_replay,
    "MARK_ORDER_PAID": _draft_mark_paid,
    "POST_LEDGER_ENTRY": _draft_post_ledger,
    "REVERSE_LEDGER_ENTRY": _draft_reverse_ledger,
    "INITIATE_REFUND": _draft_refund,
    "SYNC_REFUND_STATUS": _draft_sync_refund,
    "RAISE_SETTLEMENT_DISPUTE": _draft_dispute,
    "HOLD_PAYMENT_FOR_REVIEW": _draft_hold,
    "ESCALATE_TO_HUMAN": _draft_escalate,
}


def _replay_failed_before(history: Sequence[AttemptHistory]) -> bool:
    return any(
        "REPLAY_WEBHOOK_EVENT" in h.action_types
        and (h.verdict in ("FAIL", "PARTIAL") or h.status == "EXECUTION_FAILED")
        for h in history
    )


def recommended_types(state: CaseState, history: Sequence[AttemptHistory] = ()) -> list[str]:
    """The expected resolution for the case's shape (manual path; the agent decides for itself)."""
    s = state.order
    case_type = state.case.type
    if case_type == "PAYMENT_MISMATCH":
        if s is None or not is_captured(s.primary_gw):
            return ["ESCALATE_TO_HUMAN"]
        needs_ledger = capture_credit_minor(s) == 0
        if s.order.status not in PAID_ORDER_STATUSES and s.order.status != "CANCELLED":
            if _replay_failed_before(history) or not _replay_candidate(s):
                return ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"] if needs_ledger else ["MARK_ORDER_PAID"]
            return ["REPLAY_WEBHOOK_EVENT"]
        return ["POST_LEDGER_ENTRY"] if needs_ledger else []
    if case_type == "REFUND_EXCEPTION":
        if s is None:
            return ["ESCALATE_TO_HUMAN"]
        stuck = next(
            (
                r
                for r in s.refunds
                if r.status != "PROCESSED"
                and r.gw_refund_id
                and any(g.id == r.gw_refund_id and g.status != "PENDING" for g in s.gw_refunds)
            ),
            None,
        )
        if stuck:
            return ["SYNC_REFUND_STATUS"]
        if s.order.status == "CANCELLED" and last_transition_at(s.order, "CANCELLED"):
            return ["INITIATE_REFUND"]
        return ["ESCALATE_TO_HUMAN"]
    if case_type == "DUPLICATE":
        return ["INITIATE_REFUND"]
    if case_type == "SETTLEMENT_MISMATCH":
        return ["RAISE_SETTLEMENT_DISPUTE"]
    return ["HOLD_PAYMENT_FOR_REVIEW", "ESCALATE_TO_HUMAN"]  # RISK_CASE


def action_options(state: CaseState, history: Sequence[AttemptHistory] = ()) -> list[ActionOption]:
    recommended = set(recommended_types(state, history))
    out: list[ActionOption] = []
    for type_ in ACTION_TYPES:
        draft = DRAFTERS[type_](state)
        failures = preconditions_of(draft.action, state)
        available = not failures
        reason = (
            None
            if available
            else (
                _missing_subject(draft.action)
                or (failures[0] if failures else None)
                or f"{ACTION_META[type_].label} is not possible here."
            )
        )
        out.append(
            ActionOption(
                type=type_,
                action=draft.action,
                summary=draft.summary,
                recommended=available and type_ in recommended,
                available=available,
                unavailable_reason=reason,
                editable=draft.editable,  # type: ignore[arg-type]
                max_amount_minor=draft.max_amount_minor,
            )
        )
    return out
