"""Payment, Reconciliation and Risk tool groups (docs/03 §9), one group per specialist agent. Each tool is a pure projector over the case's already-loaded
`CaseState` (the gateway and database were read once when the case was loaded; tools never touch them again). There are no write tools here: writes only
happen in the executor."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..domain.actions.types import CaseState
from ..domain.money import format_money
from ..domain.timeutil import DAY_MS, to_iso

Draft = dict[str, Any]


def _iso(d: datetime | None) -> str:
    return to_iso(d) if d else "1970-01-01T00:00:00.000Z"


def _num(x: float) -> int | float:
    """Whole numbers stay integers, so they print the way the TypeScript code printed them (`12`, not `12.0`)."""
    return int(x) if float(x).is_integer() else x


@dataclass(frozen=True)
class ToolDef:
    name: str
    group: str
    #: Always called by the baseline (deterministic) pass.
    baseline: bool
    run: Callable[[CaseState], list[Draft]]


def _draft(source: str, system: str, entity_ref: str, facts: dict[str, Any], observed_at: str) -> Draft:
    return {"source": source, "system": system, "entityRef": entity_ref, "facts": facts, "observedAt": observed_at}


def _internal_payment(state: CaseState) -> list[Draft]:
    p = state.order.payment if state.order else None
    if p is None:
        return []
    return [_draft("getInternalPayment", "ORDER", p.id, {"status": p.status, "amountMinor": p.amount_minor, "gwPaymentId": p.gw_payment_id or "none"}, _iso(p.updated_at or p.created_at))]


def _gateway_payment(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft(
            "getGatewayPayment", "GATEWAY", g.id,
            {
                "status": g.status, "amountMinor": g.amount_minor, "method": g.method, "refundedMinor": g.refunded_minor,
                "capturedAt": to_iso(g.captured_at) if g.captured_at else "not captured",
            },
            _iso(g.captured_at or g.created_at),
        )
        for g in s.gateway
    ]


def _order(state: CaseState) -> list[Draft]:
    o = state.order.order if state.order else None
    if o is None:
        return []
    return [_draft("getOrder", "ORDER", o.id, {"status": o.status, "amountMinor": o.amount_minor}, _iso(o.updated_at))]


def _order_timeline(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft("getOrderTimeline", "ORDER", s.order.id, {"index": i, "from": t.get("from") or "none", "to": t["to"], "reason": t.get("reason") or "none"}, t["at"])
        for i, t in enumerate(s.order.timeline)
    ]


def _webhook_deliveries(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft(
            "getWebhookDeliveries", "WEBHOOK", w.id,
            {
                "event": w.event, "finalStatus": w.final_status, "attempts": len(w.attempts),
                "lastHttpStatus": (w.attempts[-1].http_status or 0) if w.attempts else 0,
            },
            to_iso(w.created_at),
        )
        for w in s.webhooks
    ]


def _payment_attempts(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [_draft("getPaymentAttempts", "GATEWAY", a.id, {"outcome": a.result, "amountMinor": a.amount_minor}, to_iso(a.at)) for a in s.recent_attempts]


def _ledger_entries(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft("getLedgerEntries", "LEDGER", e.id, {"account": e.account, "direction": e.direction, "amountMinor": e.amount_minor, "source": e.source}, to_iso(e.posted_at))
        for e in s.ledger
    ]


def _refund(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft("getRefund", "REFUND", r.id, {"status": r.status, "amountMinor": r.amount_minor, "gwRefundId": r.gw_refund_id or "none"}, to_iso(r.updated_at)) for r in s.refunds
    ]


def _refund_gateway_status(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    return [
        _draft(
            "getRefundGatewayStatus", "REFUND", r.id,
            {"status": r.status, "amountMinor": r.amount_minor, "processedAt": to_iso(r.processed_at) if r.processed_at else "not processed"}, to_iso(r.created_at),
        )
        for r in s.gw_refunds
    ]


def _settlement_lines(state: CaseState) -> list[Draft]:
    b = state.batch
    if b is None:
        return []
    return [
        _draft(
            "getSettlementLines", "SETTLEMENT", line.id,
            {"grossMinor": line.gross_minor, "feeMinor": line.fee_minor, "netMinor": line.net_minor, "lineNo": line.line_no}, to_iso(line.settled_on),
        )
        for line in b.data.lines
    ]


def _fee_breakdown(state: CaseState) -> list[Draft]:
    b = state.batch
    if b is None:
        return []
    c = b.check
    return [
        _draft(
            "getFeeBreakdown", "SETTLEMENT", b.data.settlement.id,
            {
                "expectedNetMinor": c.expected_net_minor, "reportedNetMinor": c.reported_net_minor, "diffMinor": c.diff_minor, "matched": c.diff_minor == 0,
                "summary": f"expected {format_money(c.expected_net_minor)}, reported {format_money(c.reported_net_minor)}",
            },
            to_iso(b.data.settlement.updated_at),
        )
    ]


def _customer_history(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    c = s.customer
    age = math.floor(((state.now - c.created_at).total_seconds() * 1000 / DAY_MS) * 100 + 0.5) / 100  # JS Math.round: halves go up
    flags = c.risk_flags or []
    return [
        _draft(
            "getCustomerHistory", "RISK", c.id,
            {"accountAgeDays": _num(max(0, age)), "riskFlagsCount": len(flags), "riskFlags": ",".join(flags) if flags else "none"}, _iso(c.created_at),
        )
    ]


def _device_signals(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    attempts = s.recent_attempts
    card_countries = {a.card_country for a in attempts if a.card_country}
    device_ids = {a.device_id for a in attempts}
    latest = attempts[-1] if attempts else None
    latest_device = next((d for d in s.devices if d.id == latest.device_id), None) if latest else None
    mismatch = bool(latest and latest.card_country and latest_device and latest.card_country != latest_device.ip_country)
    return [
        _draft(
            "getDeviceSignals", "RISK", s.customer.id,
            {
                "deviceCount": len(device_ids), "cardCountriesDistinct": len(card_countries),
                "primaryIpCountry": latest_device.ip_country if latest_device else "unknown", "ipCardCountryMismatch": mismatch,
            },
            _iso(latest.at if latest else None),
        )
    ]


def _failed_attempts(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    failed = sum(1 for a in s.recent_attempts if a.result == "FAILED")
    return [_draft("getFailedAttempts", "RISK", s.customer.id, {"failed24h": failed, "total24h": len(s.recent_attempts)}, _iso(s.recent_attempts[-1].at if s.recent_attempts else None))]


def _chargeback_history(state: CaseState) -> list[Draft]:
    s = state.order
    if s is None:
        return []
    disputes = s.merchant_disputes
    return [
        _draft(
            "getChargebackHistory", "RISK", s.merchant.id,
            {"merchantDisputeCount": len(disputes), "note": "merchant-level settlement disputes, not customer-level chargebacks"},
            _iso(disputes[-1].updated_at if disputes else None),
        )
    ]


PAYMENT_TOOLS = (
    ToolDef("getInternalPayment", "payment", True, _internal_payment),
    ToolDef("getGatewayPayment", "payment", True, _gateway_payment),
    ToolDef("getOrder", "payment", True, _order),
    ToolDef("getOrderTimeline", "payment", False, _order_timeline),
    ToolDef("getWebhookDeliveries", "payment", True, _webhook_deliveries),
    ToolDef("getPaymentAttempts", "payment", False, _payment_attempts),
)
RECONCILIATION_TOOLS = (
    ToolDef("getLedgerEntries", "reconciliation", True, _ledger_entries),
    ToolDef("getRefund", "reconciliation", True, _refund),
    ToolDef("getRefundGatewayStatus", "reconciliation", True, _refund_gateway_status),
    ToolDef("getSettlementLines", "reconciliation", False, _settlement_lines),
    ToolDef("getFeeBreakdown", "reconciliation", False, _fee_breakdown),
)
# Risk: all four run as baseline. J3 feeds Jev a fixed bucketed state built from all four signals at once, so there is no tool-choice step to bound.
RISK_TOOLS = (
    ToolDef("getCustomerHistory", "risk", True, _customer_history),
    ToolDef("getDeviceSignals", "risk", True, _device_signals),
    ToolDef("getFailedAttempts", "risk", True, _failed_attempts),
    ToolDef("getChargebackHistory", "risk", True, _chargeback_history),
)
ALL_TOOLS: tuple[ToolDef, ...] = (*PAYMENT_TOOLS, *RECONCILIATION_TOOLS, *RISK_TOOLS)
TOOLS_BY_NAME = {t.name: t for t in ALL_TOOLS}
