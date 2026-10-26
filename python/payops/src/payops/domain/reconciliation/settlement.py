"""D7: settlement batch check. Recomputes each line's net from the merchant contract and compares the batch total with what the gateway
reported. Pure; the service loads the inputs."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ...db.models import Dispute
from ..gateway import GatewaySettlementLine
from ..money import format_money
from .facts import FeeBreakdown, FeeTerms, expected_fee
from .rules import RuleHit


@dataclass(frozen=True)
class OffendingLine:
    line: GatewaySettlementLine
    expected: FeeBreakdown
    #: Reported net minus expected net for this line (negative means the merchant was short-paid).
    diff_minor: int


@dataclass(frozen=True)
class BatchCheck:
    batch_id: str
    expected_net_minor: int
    reported_net_minor: int
    #: Reported minus expected. Negative means the settlement is short.
    diff_minor: int
    offending_lines: list[OffendingLine]
    hit: RuleHit | None
    #: Open dispute covering the difference (D7 suppressed), if any.
    dispute_id: str | None


def covering_dispute(disputes: Sequence[Dispute], diff_minor: int) -> Dispute | None:
    """D7 is suppressed while an OPEN dispute covers exactly the batch's difference: the shortfall is claimed and waiting on the acquirer."""
    if diff_minor == 0:
        return None
    return next((d for d in disputes if d.status == "OPEN" and d.amount_minor == abs(diff_minor)), None)


def check_batch(
    settlement_id: str, lines: Sequence[GatewaySettlementLine], merchant: FeeTerms, disputes: Sequence[Dispute] = ()
) -> BatchCheck:
    ordered = sorted(lines, key=lambda line: line.line_no)
    offending: list[OffendingLine] = []
    expected_net = 0
    for line in ordered:
        expected = expected_fee(line.gross_minor, merchant)
        expected_net += expected.net_minor
        if line.net_minor != expected.net_minor:
            offending.append(OffendingLine(line, expected, line.net_minor - expected.net_minor))
    reported_net = sum(line.net_minor for line in ordered)
    diff = reported_net - expected_net
    magnitude = abs(diff)
    covering = covering_dispute(disputes, diff)
    dispute_id = covering.id if covering else None
    hit: RuleHit | None = None
    if diff != 0 and dispute_id is None:
        hit = RuleHit(
            "D7_SETTLEMENT_DIFF", "SETTLEMENT_MISMATCH", ("batch", settlement_id), magnitude,
            f"Batch net is {'short' if diff < 0 else 'over'} by {format_money(magnitude)} across {len(offending)} line{'' if len(offending) == 1 else 's'}.",
            severity_floor="MEDIUM",
        )
    return BatchCheck(settlement_id, expected_net, reported_net, diff, offending, hit, dispute_id)
