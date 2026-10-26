"""What each catalog action does to the world. Preconditions and postconditions are pure and live in `domain/actions`; execution writes, so it lives
here. Each handler opens its own short transactions and never holds one while calling the gateway. (packages/core actions/handlers/*)"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...domain.actions.facts import NO_ORDER
from ...domain.actions.types import CaseState
from ...domain.gateway import PaymentGateway
from ...domain.ledger import summarize_journals
from ...domain.money import format_money
from ...domain.reconciliation.facts import CAPTURE_KNOWN_STATUSES
from ...dto.actions import CatalogAction
from ...errors import AppError
from ...ports import Clock
from ..audit import WriteContext
from .cases import CaseWriteService
from .disputes import DisputeWriteService
from .ledger import LedgerWriteService
from .orders import OrderService, TransitionOptions
from .payments import PaymentWriteService
from .refunds import REFUND_STATUS_FROM_GATEWAY, RefundWriteService


@dataclass
class ExecDeps:
    sessions: async_sessionmaker[AsyncSession]
    clock: Clock
    gateway: PaymentGateway
    orders: OrderService
    ledger: LedgerWriteService
    payments: PaymentWriteService
    refunds: RefundWriteService
    disputes: DisputeWriteService
    cases: CaseWriteService


@dataclass
class ExecContext:
    deps: ExecDeps
    write: WriteContext
    resolution_id: str


@dataclass
class ExecOutcome:
    #: Plain-language outcome shown on the execution step.
    summary: str
    result: dict[str, Any]


def _http_label(status: int | None) -> str:
    return "no answer" if status is None else f"HTTP {status}"


async def _replay_webhook(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    event_id = action.params.event_id
    delivery = next((w for w in state.order.webhooks if w.id == event_id), None) if state.order else None
    result = await ctx.deps.gateway.replay_webhook(event_id)
    ok = result.http_status is not None and 200 <= result.http_status < 300
    event = delivery.event if delivery else "event"
    tail = "" if ok else ", so nothing changed"
    return ExecOutcome(
        f"Gateway re-delivered {event} ({event_id}): consumer answered {_http_label(result.http_status)}{tail}",
        {"httpStatus": result.http_status, "attemptAt": result.attempt_at},
    )


async def _mark_order_paid(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    s = state.order
    if s is None or s.payment is None:
        raise RuntimeError(NO_ORDER)
    p = action.params
    payment, previous = s.payment, s.order.status
    async with transaction(ctx.deps.sessions) as session:
        await ctx.deps.orders.transition(
            session, p.order_id, "PAID",
            TransitionOptions(by="executor", reason=f"Gateway capture {payment.gw_payment_id} verified", expected_version=s.order.version, payment_id=p.payment_id),
            ctx.write,
        )
        updated = False
        if payment.status not in CAPTURE_KNOWN_STATUSES:
            await ctx.deps.payments.set_status(session, p.payment_id, "CAPTURED", f"gateway capture {payment.gw_payment_id} verified", ctx.write)
            updated = True
    note = "; internal payment marked CAPTURED" if updated else ""
    return ExecOutcome(f"Order {p.order_id} moved {previous} to PAID and linked to {p.payment_id}{note}", {"from": previous, "to": "PAID", "paymentUpdated": updated})


async def _post_ledger_entry(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    payment = state.order.payment if state.order else None
    if payment is None:
        raise RuntimeError(NO_ORDER)
    p = action.params
    async with transaction(ctx.deps.sessions) as session:
        journal_id = await ctx.deps.ledger.post_capture(session, payment_id=p.payment_id, merchant_id=payment.merchant_id, amount_minor=p.amount_minor, source="EXECUTOR", ctx=ctx.write)
    return ExecOutcome(f"Posted capture journal {journal_id} for {format_money(p.amount_minor)}: debit settlement clearing, credit merchant payable", {"journalId": journal_id})


async def _reverse_ledger_entry(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    journal_id = action.params.journal_id
    journal = next((j for j in summarize_journals(state.order.ledger if state.order else []) if j.journal_id == journal_id), None)
    async with transaction(ctx.deps.sessions) as session:
        reversal_id = await ctx.deps.ledger.reverse_journal(session, journal_id, "EXECUTOR", ctx.write)
    amount = f" ({format_money(journal.amount_minor)})" if journal else ""
    return ExecOutcome(f"Reversed journal {journal_id}{amount} with {reversal_id}; the original stays on the ledger", {"reversalId": reversal_id})


async def _initiate_refund(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    p, deps = action.params, ctx.deps
    async with transaction(deps.sessions) as session:
        requested = await deps.refunds.create_requested(session, gw_payment_id=p.gw_payment_id, amount_minor=p.amount_minor, reason=p.reason, ctx=ctx.write)
    try:
        gw_refund = await deps.gateway.create_refund(p.gw_payment_id, p.amount_minor)
    except Exception as err:
        message = err.message if isinstance(err, AppError) else (str(err) or "Gateway error")
        async with transaction(deps.sessions) as session:
            await deps.refunds.mark_failed(session, await deps.refunds.lock(session, requested.id), message, ctx.write)
        raise err if isinstance(err, AppError) else AppError("CONFLICT", message) from err
    gw_payment = (await deps.gateway.get_payments([p.gw_payment_id]) or [None])[0]
    if gw_payment is None:
        raise AppError("NOT_FOUND", f"Gateway payment {p.gw_payment_id} not found")
    async with transaction(deps.sessions) as session:
        row = await deps.refunds.lock(session, requested.id)
        if row.gw_refund_id == gw_refund.id and row.status == REFUND_STATUS_FROM_GATEWAY[gw_refund.status]:
            final = row
        elif gw_refund.status == "FAILED":
            await deps.refunds.mark_failed(session, row, f"gateway refund {gw_refund.id} failed", ctx.write)
            final = row
        else:
            final = await deps.refunds.apply_gateway_status(session, row, gw_refund, gw_payment, "EXECUTOR", ctx.write)
    posted = " and posted to the ledger" if final.status == "PROCESSED" else ""
    return ExecOutcome(
        f"Gateway refunded {format_money(p.amount_minor)} on {p.gw_payment_id} ({gw_refund.id}, {gw_refund.status}); refund {final.id} is {final.status}{posted}",
        {"refundId": final.id, "gwRefundId": gw_refund.id, "gatewayStatus": gw_refund.status, "status": final.status},
    )


async def _sync_refund_status(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    deps = ctx.deps
    refund = next((r for r in state.order.refunds if r.id == action.params.refund_id), None) if state.order else None
    if refund is None or not refund.gw_refund_id:
        raise RuntimeError(f"Refund {action.params.refund_id} has no gateway refund")
    gw_refunds = await deps.gateway.list_refunds([refund.gw_payment_id])
    gw_payment = (await deps.gateway.get_payments([refund.gw_payment_id]) or [None])[0]
    gw_refund = next((r for r in gw_refunds if r.id == refund.gw_refund_id), None)
    if gw_refund is None or gw_payment is None:
        raise AppError("NOT_FOUND", f"Gateway refund {refund.gw_refund_id} not found")
    previous = refund.status
    async with transaction(deps.sessions) as session:
        row = await deps.refunds.lock(session, refund.id)
        if gw_refund.status == "FAILED":
            await deps.refunds.mark_failed(session, row, f"gateway refund {gw_refund.id} failed", ctx.write)
        else:
            await deps.refunds.apply_gateway_status(session, row, gw_refund, gw_payment, "EXECUTOR", ctx.write)
    to = REFUND_STATUS_FROM_GATEWAY[gw_refund.status]
    posted = f"; refund journal of {format_money(refund.amount_minor)} posted" if to == "PROCESSED" else ""
    return ExecOutcome(f"Refund {refund.id} moved {previous} to {to} to match gateway refund {gw_refund.id}{posted}", {"from": previous, "to": to, "gwRefundId": gw_refund.id})


async def _raise_settlement_dispute(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    p = action.params
    check = state.batch.check if state.batch else None
    lines = len(check.offending_lines) if check else 0
    direction = "short" if (check.diff_minor if check else 0) < 0 else "over"
    reason = f"Batch net {direction} by {format_money(p.amount_minor)} across {lines} line{'' if lines == 1 else 's'} charged off contract"
    async with transaction(ctx.deps.sessions) as session:
        dispute = await ctx.deps.disputes.raise_settlement(
            session, batch_id=p.batch_id, gw_payment_id=p.gw_payment_id, amount_minor=p.amount_minor, reason=reason, resolution_id=ctx.resolution_id, ctx=ctx.write
        )
    return ExecOutcome(f"Raised settlement dispute {dispute.id} for {format_money(p.amount_minor)} on batch {p.batch_id}", {"disputeId": dispute.id})


async def _hold_payment(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    p = action.params
    async with transaction(ctx.deps.sessions) as session:
        payment = await ctx.deps.payments.hold(session, p.payment_id, f"review for case {state.case.display_id}", ctx.write)
    return ExecOutcome(f"Payment {p.payment_id} ({format_money(payment.amount_minor)}) is on hold and excluded from payouts", {"hold": True})


async def _escalate(action: Any, state: CaseState, ctx: ExecContext) -> ExecOutcome:
    p = action.params
    who = "a manager" if p.to == "MANAGER" else "the ops team"
    summary = f"Escalated {state.case.display_id} to {who}: {p.reason}"
    async with transaction(ctx.deps.sessions) as session:
        await ctx.deps.cases.set_status(session, state.case.id, "ESCALATED", summary, ctx.write)
    return ExecOutcome(summary, {"to": p.to})


_EXECUTORS: dict[str, Callable[[Any, CaseState, ExecContext], Awaitable[ExecOutcome]]] = {
    "REPLAY_WEBHOOK_EVENT": _replay_webhook,
    "MARK_ORDER_PAID": _mark_order_paid,
    "POST_LEDGER_ENTRY": _post_ledger_entry,
    "REVERSE_LEDGER_ENTRY": _reverse_ledger_entry,
    "INITIATE_REFUND": _initiate_refund,
    "SYNC_REFUND_STATUS": _sync_refund_status,
    "RAISE_SETTLEMENT_DISPUTE": _raise_settlement_dispute,
    "HOLD_PAYMENT_FOR_REVIEW": _hold_payment,
    "ESCALATE_TO_HUMAN": _escalate,
}


def execute_action(action: CatalogAction, state: CaseState, ctx: ExecContext) -> Awaitable[ExecOutcome]:
    return _EXECUTORS[action.type](action, state, ctx)
