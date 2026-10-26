"""Merged, chronological lifecycle of one order across every system. This is what an analyst would otherwise assemble by hand from four
dashboards. Titles are plain ops language."""

from __future__ import annotations

import math
from typing import Final

from ...dto.matrix import LifecycleEvent
from ..money import format_money, group_indian
from ..snapshot import OrderSnapshot
from ..timeutil import to_iso

#: Tie-break for events at the same instant: the order money actually flows through systems.
SYSTEM_ORDER: Final = {"RISK": 0, "ORDER": 1, "GATEWAY": 2, "WEBHOOK": 3, "LEDGER": 4, "REFUND": 5, "SETTLEMENT": 6}
#: Failed attempts are only interesting as a pattern.
RISK_MIN_FAILED_ATTEMPTS: Final = 3
ORDER_TONE: Final = {"PENDING": "neutral", "PAID": "ok", "FULFILLED": "ok", "FAILED": "bad", "CANCELLED": "warn"}


def build_lifecycle(s: OrderSnapshot) -> list[LifecycleEvent]:
    events = [*_order(s), *_gateway(s), *_webhooks(s), *_ledger(s), *_refunds(s), *_settlement(s), *_risk(s)]
    indexed = sorted(enumerate(events), key=lambda p: (p[1].at, SYSTEM_ORDER[p[1].system], p[0]))
    return [e for _, e in indexed]


def _event(at: str, system: str, title: str, detail: str | None, tone: str) -> LifecycleEvent:
    return LifecycleEvent(at=at, system=system, title=title, detail=detail, tone=tone)  # type: ignore[arg-type]


def _order(s: OrderSnapshot) -> list[LifecycleEvent]:
    out: list[LifecycleEvent] = []
    order = s.order
    timeline = order.timeline
    if not timeline or timeline[0]["from"] is not None:
        out.append(_event(to_iso(order.created_at), "ORDER", "Order created", format_money(order.amount_minor), "neutral"))
    for t in timeline:
        reason = f" · {t['reason']}" if t.get("reason") else ""
        if t["from"] is None:
            out.append(_event(t["at"], "ORDER", "Order created", f"{format_money(order.amount_minor)} · by {t['by']}", "neutral"))
        else:
            out.append(_event(t["at"], "ORDER", f"Order {t['from']} to {t['to']}", f"by {t['by']}{reason}", ORDER_TONE[t["to"]]))
    return out


def _gateway(s: OrderSnapshot) -> list[LifecycleEvent]:
    out: list[LifecycleEvent] = []
    captures = sorted((g for g in s.gateway if g.captured_at), key=lambda g: g.captured_at)  # type: ignore[arg-type,return-value]
    for g in s.gateway:
        card = f" · {g.card['network']} {g.card['last4']} ({g.card['country']})" if g.card else ""
        out.append(_event(to_iso(g.created_at), "GATEWAY", "Gateway payment created", f"{g.id} · {g.method}{card}", "neutral"))
        if g.status == "FAILED":
            out.append(_event(to_iso(g.created_at), "GATEWAY", "Gateway payment failed", g.id, "bad"))
    for index, g in enumerate(captures):
        repeat = index > 0
        out.append(
            _event(
                to_iso(g.captured_at),  # type: ignore[arg-type]
                "GATEWAY",
                f"Captured {format_money(g.amount_minor)} again at gateway" if repeat else f"Captured {format_money(g.amount_minor)} at gateway",
                f"{g.id} · capture {index + 1} for this order" if repeat else g.id,
                "bad" if repeat else "ok",
            )
        )
    return out


def _webhooks(s: OrderSnapshot) -> list[LifecycleEvent]:
    out: list[LifecycleEvent] = []
    for w in s.webhooks:
        total = len(w.attempts)
        for i, a in enumerate(w.attempts):
            failed = a.http_status is None or a.http_status >= 400
            code = (a.error or "No response") if a.http_status is None else f"HTTP {a.http_status}"
            attempt = f"Attempt {i + 1} of {total} · " if total > 1 else ""
            out.append(
                _event(
                    a.at, "WEBHOOK", f"{w.event} delivery failed" if failed else f"{w.event} delivered",
                    f"{attempt}{code} · {group_indian(a.latency_ms)} ms", "bad" if failed else "ok",
                )
            )
    return out


def _ledger(s: OrderSnapshot) -> list[LifecycleEvent]:
    journals: dict[str, list] = {}
    for e in s.ledger:
        journals.setdefault(e.journal_id, []).append(e)
    out: list[LifecycleEvent] = []
    for legs in journals.values():
        payable = next((leg for leg in legs if leg.account == "MERCHANT_PAYABLE"), None)
        first = legs[0]
        amount = (payable or first).amount_minor
        reversal = any(leg.reversal_of is not None for leg in legs)
        if reversal:
            title = "Ledger reversal posted"
        elif first.refund_id:
            title = "Refund posted to ledger"
        else:
            title = "Capture posted to ledger"
        direction = "debit" if payable is not None and payable.direction == "DEBIT" else "credit"
        out.append(_event(to_iso(first.posted_at), "LEDGER", title, f"{format_money(amount)} {direction} to MERCHANT_PAYABLE · {first.source}", "warn" if reversal else "ok"))
    return out


def _refunds(s: OrderSnapshot) -> list[LifecycleEvent]:
    out: list[LifecycleEvent] = []
    for r in s.refunds:
        out.append(_event(to_iso(r.requested_at), "REFUND", "Refund requested", f"{format_money(r.amount_minor)} · {r.reason}", "neutral"))
        if r.status in ("PROCESSED", "FAILED"):
            processed = r.status == "PROCESSED"
            out.append(
                _event(
                    to_iso(r.updated_at), "REFUND",
                    "Refund marked processed internally" if processed else "Refund failed internally",
                    format_money(r.amount_minor), "ok" if processed else "bad",
                )
            )
    for g in s.gw_refunds:
        out.append(_event(to_iso(g.created_at), "REFUND", "Refund initiated at gateway", f"{g.id} · {format_money(g.amount_minor)}", "neutral"))
        if g.status == "PROCESSED" and g.processed_at:
            out.append(_event(to_iso(g.processed_at), "REFUND", "Refund processed at gateway", f"{g.id} · {format_money(g.amount_minor)}", "ok"))
        elif g.status == "FAILED":
            out.append(_event(to_iso(g.processed_at or g.created_at), "REFUND", "Refund failed at gateway", g.id, "bad"))
    return out


def _settlement(s: OrderSnapshot) -> list[LifecycleEvent]:
    return [
        _event(
            to_iso(line.settled_on), "SETTLEMENT", f"Settled in batch {line.batch_id}",
            f"Gross {format_money(line.gross_minor)} · fee {format_money(line.fee_minor)} · tax {format_money(line.tax_minor)} · net {format_money(line.net_minor)}",
            "neutral",
        )
        for line in s.settlement_lines
    ]


def _risk(s: OrderSnapshot) -> list[LifecycleEvent]:
    failed = sorted((a for a in s.recent_attempts if a.result == "FAILED"), key=lambda a: a.at)
    if len(failed) < RISK_MIN_FAILED_ATTEMPTS:
        return []
    first, last = failed[0], failed[-1]
    countries = sorted({a.card_country for a in failed if a.card_country is not None})
    span_min = max(1, math.floor((last.at - first.at).total_seconds() / 60 + 0.5))
    codes = sorted({a.failure_code for a in failed if a.failure_code is not None})
    detail = " · ".join(
        part
        for part in (f"Card countries: {', '.join(countries)}" if countries else None, f"Codes: {', '.join(codes)}" if codes else None)
        if part
    )
    return [_event(to_iso(last.at), "RISK", f"{len(failed)} failed payment attempts in {span_min} min", detail, "warn")]
