"""Read-only operator view of fresh domain and gateway records behind a case. No model output is used. (packages/core case-source-records.ts)"""

from __future__ import annotations

from ..dto.case_detail import CaseSourceDetail, CaseSourceRecord, CaseSourceRecords
from .actions.types import CaseState
from .money import format_money
from .timeutil import to_iso


def _d(label: str, value: str) -> CaseSourceDetail:
    return CaseSourceDetail(label=label, value=value)


def project_case_source_records(state: CaseState) -> CaseSourceRecords:
    records: list[CaseSourceRecord] = []

    def add(system: str, kind: str, id_: str, status: str, amount_minor: int | None, at, details: list[CaseSourceDetail]) -> None:
        records.append(CaseSourceRecord(system=system, kind=kind, id=id_, status=status, amount_minor=amount_minor, at=to_iso(at), details=details))  # type: ignore[arg-type]

    order = state.order
    if order:
        for p in order.gateway:
            add(
                "GATEWAY",
                "Gateway payment",
                p.id,
                p.status,
                p.amount_minor,
                p.captured_at or p.created_at,
                [_d("Order", p.order_ref), _d("Refunded", format_money(p.refunded_minor))],
            )
        add(
            "ORDER",
            "Order",
            order.order.id,
            order.order.status,
            order.order.amount_minor,
            order.order.updated_at,
            [_d("Linked payment", order.order.payment_id or "None"), _d("Version", str(order.order.version))],
        )
        if order.payment:
            add(
                "ORDER",
                "Internal payment",
                order.payment.id,
                order.payment.status,
                order.payment.amount_minor,
                order.payment.updated_at,
                [_d("Gateway payment", order.payment.gw_payment_id), _d("Held", "Yes" if order.payment.hold else "No")],
            )
        for w in order.webhooks:
            add(
                "WEBHOOK",
                "Webhook delivery",
                w.id,
                w.final_status,
                None,
                w.created_at,
                [
                    _d("Event", w.event),
                    _d("Gateway payment", w.gw_payment_id),
                    *[
                        _d(f"Attempt {i + 1}", f"HTTP {a.http_status if a.http_status is not None else 'no response'} · {a.at}")
                        for i, a in enumerate(w.attempts)
                    ],
                ],
            )
        for e in order.ledger:
            add(
                "LEDGER",
                "Ledger entry",
                e.id,
                f"{e.direction} {e.account}",
                e.amount_minor,
                e.posted_at,
                [_d("Journal", e.journal_id), _d("Payment", e.payment_id or "None"), _d("Source", e.source)],
            )
        for r in order.refunds:
            add(
                "REFUND",
                "Internal refund",
                r.id,
                r.status,
                r.amount_minor,
                r.updated_at,
                [_d("Gateway payment", r.gw_payment_id), _d("Gateway refund", r.gw_refund_id or "None")],
            )
        for r in order.gw_refunds:
            add("REFUND", "Gateway refund", r.id, r.status, r.amount_minor, r.processed_at or r.created_at, [_d("Gateway payment", r.gw_payment_id)])
        for line in order.settlement_lines:
            add(
                "SETTLEMENT",
                "Gateway settlement line",
                line.id,
                "SETTLED",
                line.net_minor,
                line.settled_on,
                [
                    _d("Batch", line.batch_id),
                    _d("Gateway payment", line.gw_payment_id),
                    _d("Gross", format_money(line.gross_minor)),
                    _d("Fee", format_money(line.fee_minor)),
                    _d("Tax", format_money(line.tax_minor)),
                ],
            )
    if state.batch:
        data, check = state.batch.data, state.batch.check
        s = data.settlement
        add(
            "SETTLEMENT",
            "Settlement batch",
            s.id,
            s.status,
            s.reported_net_minor,
            s.settled_on,
            [
                _d("Expected from contract", format_money(check.expected_net_minor)),
                _d("Reported by gateway", format_money(check.reported_net_minor)),
                _d("Difference", format_money(check.diff_minor)),
            ],
        )
        for line in data.lines:
            expected = next((o for o in check.offending_lines if o.line.id == line.id), None)
            add(
                "SETTLEMENT",
                "Gateway settlement line",
                line.id,
                "AMOUNT DIFFERS" if expected else "MATCHED",
                line.net_minor,
                line.settled_on,
                [
                    _d("Gateway payment", line.gw_payment_id),
                    _d("Gross", format_money(line.gross_minor)),
                    _d("Fee", format_money(line.fee_minor)),
                    _d("Tax", format_money(line.tax_minor)),
                    *([_d("Expected net", format_money(expected.expected.net_minor))] if expected else []),
                ],
            )
        for d in data.disputes:
            add("DISPUTE", "Settlement dispute", d.id, d.status, d.amount_minor, d.updated_at, [_d("Batch", d.batch_id), _d("Reason", d.reason)])
    return CaseSourceRecords(case_id=state.case.id, read_at=to_iso(state.now), records=records)
