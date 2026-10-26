"""The state matrix: one payment as each system sees it. The gateway is the reference for money movement; every other cell is marked
`mismatch` when it disagrees with what the gateway did."""

from __future__ import annotations

from typing import Final

from ...dto.matrix import MatrixCell, StateMatrix, SystemKey
from ..enums import SYSTEMS
from ..gateway import GatewayWebhookDelivery
from ..money import format_money
from ..snapshot import OrderSnapshot
from ..timeutil import to_iso
from .facts import (
    CAPTURE_KNOWN_STATUSES,
    PAID_ORDER_STATUSES,
    capture_credit_minor,
    captured_gw,
    captured_total_minor,
    expected_fee,
    gateway_processed_refund_minor,
    held_captures,
    is_captured,
    outstanding_captured_minor,
    refund_posted_minor,
)

#: Display codes used in ledger, settlement and webhook cells. Also read by list views.
LEDGER_CODES: Final = {
    "posted": "POSTED",
    "missing": "MISSING",
    "partial": "PARTIAL",
    "refundMissing": "REFUND MISSING",
    "notExpected": "NOT EXPECTED",
}
SETTLEMENT_CODES: Final = {"settled": "SETTLED", "feeMismatch": "FEE MISMATCH", "pending": "PENDING", "notExpected": "NOT EXPECTED"}


def _cell(system: SystemKey, **fields: object) -> MatrixCell:
    return MatrixCell(system=system, **fields)  # type: ignore[arg-type]


def _matrix(cells: dict[SystemKey, MatrixCell]) -> StateMatrix:
    return StateMatrix(cells=cells, mismatched=[k for k in SYSTEMS if cells[k].mismatch])  # type: ignore[misc]


def build_matrix(s: OrderSnapshot) -> StateMatrix:
    return _matrix(
        {
            "GATEWAY": _gateway_cell(s),
            "ORDER": _order_cell(s),
            "LEDGER": _ledger_cell(s),
            "WEBHOOK": _webhook_cell(s),
            "SETTLEMENT": _settlement_cell(s),
        }
    )


def blank_matrix(overrides: dict[SystemKey, dict[str, object]] | None = None) -> StateMatrix:
    """A matrix with empty cells, for cases that have no single payment to show (for example a batch)."""
    overrides = overrides or {}
    return _matrix({k: _cell(k, **{"reference": k == "GATEWAY", **overrides.get(k, {})}) for k in SYSTEMS})  # type: ignore[misc]


def _iso(moment) -> str | None:
    return to_iso(moment) if moment else None


def _gateway_cell(s: OrderSnapshot) -> MatrixCell:
    primary = s.primary_gw
    if primary is None:
        return _cell("GATEWAY", reference=True, detail="No gateway payment for this order")
    captured = captured_gw(s)
    # A second capture that was refunded in full is no longer a live duplicate.
    duplicate = len(held_captures(s)) > 1
    if duplicate:
        detail: str | None = f"{len(captured)} captures on one order"
    elif s.gw_refunds:
        detail = " · ".join(f"Refund {format_money(r.amount_minor)} {r.status}" for r in s.gw_refunds)
    elif primary.card:
        detail = f"{primary.method} · {primary.card['network']} {primary.card['last4']}"
    else:
        detail = primary.method
    return _cell(
        "GATEWAY",
        status=f"CAPTURED ×{len(captured)}" if len(captured) > 1 else primary.status,
        amount_minor=captured_total_minor(s) if captured else primary.amount_minor,
        at=_iso(primary.captured_at or primary.created_at),
        detail=detail,
        mismatch=duplicate,
        reference=True,
    )


def _order_cell(s: OrderSnapshot) -> MatrixCell:
    order = s.order
    timeline = order.timeline
    last = timeline[-1] if timeline else None
    paid = order.status in PAID_ORDER_STATUSES
    money_held = outstanding_captured_minor(s) > 0
    nothing_captured = not captured_gw(s)
    return _cell(
        "ORDER",
        status=order.status,
        amount_minor=order.amount_minor,
        at=last["at"] if last else _iso(order.created_at),
        detail=f"Internal payment {s.payment.status}" if s.payment else None,
        mismatch=(money_held and not paid) or (paid and nothing_captured),
    )


def _ledger_cell(s: OrderSnapshot) -> MatrixCell:
    primary = s.primary_gw
    primary_captured = is_captured(primary)
    any_captured = bool(captured_gw(s))
    credit = capture_credit_minor(s)
    has_capture_entries = any(e.refund_id is None for e in s.ledger)
    refund_gap = gateway_processed_refund_minor(s) - refund_posted_minor(s)
    last_posted = max((e.posted_at for e in s.ledger), default=None)

    detail: str | None = None
    if primary is None or not primary_captured:
        if s.ledger:
            status, detail = LEDGER_CODES["partial"], "Ledger entries without a gateway capture"
        elif any_captured:
            status, detail = LEDGER_CODES["missing"], f"No capture credit for {format_money(captured_total_minor(s))}"
        else:
            status = LEDGER_CODES["notExpected"]
    elif credit == 0:
        status, detail = LEDGER_CODES["missing"], f"No capture credit for {format_money(primary.amount_minor)}"
    elif credit != primary.amount_minor:
        status, detail = LEDGER_CODES["partial"], f"Credit {format_money(credit)} vs captured {format_money(primary.amount_minor)}"
    elif refund_gap > 0:
        status, detail = LEDGER_CODES["refundMissing"], f"Refund {format_money(refund_gap)} processed at gateway, not posted"
    else:
        status, detail = LEDGER_CODES["posted"], "Capture journal posted"
    mismatch = status in (LEDGER_CODES["missing"], LEDGER_CODES["partial"], LEDGER_CODES["refundMissing"])
    return _cell("LEDGER", status=status, amount_minor=credit if has_capture_entries else None, at=_iso(last_posted), detail=detail, mismatch=mismatch)


def relevant_deliveries(s: OrderSnapshot) -> list[GatewayWebhookDelivery]:
    """The payment.captured delivery of the primary gateway payment plus any refund deliveries."""
    primary_id = s.primary_gw.id if s.primary_gw else None
    return [w for w in s.webhooks if (w.event == "payment.captured" and w.gw_payment_id == primary_id) or w.event.startswith("refund.")]


def _last_attempt_at(w: GatewayWebhookDelivery) -> str | None:
    return w.attempts[-1].at if w.attempts else None


def _latest(deliveries: list[GatewayWebhookDelivery]) -> GatewayWebhookDelivery | None:
    return sorted(deliveries, key=lambda w: _last_attempt_at(w) or "")[-1] if deliveries else None


def delivery_caught_up(s: OrderSnapshot, w: GatewayWebhookDelivery) -> bool:
    """A failed delivery stops mattering once our records caught up another way (for example an analyst marked the order paid, or synced the
    refund). It is still shown, but not as a mismatch."""
    if w.event == "payment.captured":
        return s.payment is not None and s.payment.gw_payment_id == w.gw_payment_id and s.payment.status in CAPTURE_KNOWN_STATUSES
    if w.event in ("refund.processed", "refund.failed"):
        want = "PROCESSED" if w.event == "refund.processed" else "FAILED"
        return any(r.gw_refund_id is not None and r.gw_refund_id == w.gw_refund_id and r.status == want for r in s.refunds)
    return False


def _failure_code(w: GatewayWebhookDelivery) -> str:
    last = w.attempts[-1] if w.attempts else None
    code = f"HTTP {last.http_status}" if last is not None and last.http_status is not None else "TIMEOUT"
    return f"{code} ×{len(w.attempts)}"


def _webhook_cell(s: OrderSnapshot) -> MatrixCell:
    relevant = relevant_deliveries(s)
    failed_all = [w for w in relevant if w.final_status == "FAILED"]
    failed = _latest([w for w in failed_all if not delivery_caught_up(s, w)])
    if failed:
        return _cell("WEBHOOK", status=_failure_code(failed), at=_last_attempt_at(failed), detail=failed.event, mismatch=True)
    caught_up = _latest(failed_all)
    if caught_up:
        return _cell(
            "WEBHOOK", status=_failure_code(caught_up), at=_last_attempt_at(caught_up),
            detail=f"{caught_up.event} not delivered; internal records updated another way",
        )
    pending = _latest([w for w in relevant if w.final_status == "PENDING"])
    if pending:
        return _cell("WEBHOOK", status="PENDING", at=_last_attempt_at(pending), detail=pending.event)
    delivered = _latest([w for w in relevant if w.final_status == "DELIVERED"])
    if delivered:
        return _cell("WEBHOOK", status="DELIVERED", at=_last_attempt_at(delivered), detail=delivered.event)
    return _cell("WEBHOOK", status="NONE")


def _settlement_cell(s: OrderSnapshot) -> MatrixCell:
    primary = s.primary_gw
    line = next((line for line in s.settlement_lines if primary is not None and line.gw_payment_id == primary.id), None)
    if line is not None:
        expected = expected_fee(line.gross_minor, s.merchant)
        charged = line.fee_minor + line.tax_minor
        contract = expected.fee_minor + expected.tax_minor
        fee_mismatch = charged != contract
        return _cell(
            "SETTLEMENT",
            status=SETTLEMENT_CODES["feeMismatch"] if fee_mismatch else SETTLEMENT_CODES["settled"],
            amount_minor=line.net_minor,
            at=to_iso(line.settled_on),
            detail=f"Fee {format_money(charged)} vs contract {format_money(contract)}" if fee_mismatch else f"Batch {line.batch_id}",
            mismatch=fee_mismatch,
        )
    if is_captured(primary):
        return _cell("SETTLEMENT", status=SETTLEMENT_CODES["pending"], detail="Awaiting settlement file")
    return _cell("SETTLEMENT", status=SETTLEMENT_CODES["notExpected"])
