"""Turns rule hits into case candidates. Hits that share `case_type:primary_entity_id` become one candidate (so D1 and
D3 on the same payment are one case), which the case service then opens or merges into the existing open case with that
fingerprint."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from ...dto.matrix import StateMatrix
from ..enums import SEVERITY_RANK
from ..money import amount_band
from ..snapshot import OrderSnapshot
from .facts import captured_gw
from .matrix import build_matrix
from .rules import RuleHit, run_order_rules

#: Case entity references as stored (camelCase keys: orderId, customerId, paymentId, batchId, ...).
EntityRefs = dict[str, Any]


@dataclass(frozen=True)
class CaseCandidate:
    fingerprint: str
    type: str
    rule_ids: list[str]
    severity: str
    priority: int
    amount_minor: int
    entity_refs: EntityRefs
    matrix: StateMatrix


def fingerprint_of(hit: RuleHit) -> str:
    return f"{hit.case_type}:{hit.entity_id}"


def max_severity(*values: str | None) -> str:
    best = "LOW"
    for v in values:
        if v and SEVERITY_RANK[v] > SEVERITY_RANK[best]:
            best = v
    return best


def priority_of(severity: str, amount_minor: int) -> int:
    """Queue order: severity first, then amount in whole rupees (capped so it never spills into the next severity band).
    Higher is more urgent."""
    return SEVERITY_RANK[severity] * 1_000_000 + min(999_999, abs(amount_minor) // 100)


def group_hits(hits: Sequence[RuleHit], entity_refs: EntityRefs, matrix: StateMatrix) -> list[CaseCandidate]:
    groups: dict[str, list[RuleHit]] = {}
    for hit in hits:
        groups.setdefault(fingerprint_of(hit), []).append(hit)
    candidates: list[CaseCandidate] = []
    for fingerprint, group in groups.items():
        first = group[0]
        amount = max(h.amount_minor for h in group)
        severity = max_severity(amount_band(amount), *(h.severity_floor for h in group))
        refs = dict(entity_refs)
        if first.entity_kind == "batch":
            refs["batchId"] = first.entity_id
        candidates.append(
            CaseCandidate(
                fingerprint,
                first.case_type,
                sorted({h.rule_id for h in group}),
                severity,
                priority_of(severity, amount),
                amount,
                refs,
                matrix,
            )
        )
    return candidates


def snapshot_entity_refs(s: OrderSnapshot) -> EntityRefs:
    """Every entity a case about this order may need to link to."""
    refs: EntityRefs = {"orderId": s.order.id, "customerId": s.customer.id, "merchantId": s.merchant.id}
    if s.payment:
        refs["paymentId"] = s.payment.id
    if s.primary_gw:
        refs["gwPaymentId"] = s.primary_gw.id
    if s.refunds:
        refs["refundId"] = s.refunds[0].id
    primary_id = s.primary_gw.id if s.primary_gw else None
    line = next((line for line in s.settlement_lines if line.gw_payment_id == primary_id), None)
    if line:
        refs["batchId"] = line.batch_id
    captured = captured_gw(s)
    if len(captured) > 1:
        refs["duplicateGwPaymentIds"] = [g.id for g in captured if g.id != primary_id]
    return refs


@dataclass(frozen=True)
class OrderEvaluation:
    matrix: StateMatrix
    hits: list[RuleHit]
    candidates: list[CaseCandidate]


def evaluate_order(s: OrderSnapshot) -> OrderEvaluation:
    """Matrix, rules and grouping for one order snapshot."""
    matrix = build_matrix(s)
    hits = run_order_rules(s)
    return OrderEvaluation(matrix, hits, group_hits(hits, snapshot_entity_refs(s), matrix))
