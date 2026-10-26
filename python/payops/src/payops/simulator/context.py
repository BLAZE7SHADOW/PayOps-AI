"""Shared state while one scenario is written: the transaction, the seeded id generator, the clock's "now", and what has been created so far."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import GwSettlementLine, Settlement
from ..domain.ids import IdGenerator
from ..domain.money import bps_of
from .world import World, WorldMerchant

#: Settlement cycle is T+1 for every demo merchant.
MERCHANT_CYCLE_MS = 24 * 60 * 60 * 1000


@dataclass
class PendingLine:
    """A gateway settlement line waiting to be grouped into a batch."""

    group: str
    merchant: WorldMerchant
    gw_payment_id: str
    payment_id: str | None
    gross_minor: int
    captured_at: datetime
    fee_bps: int


@dataclass
class Created:
    payment_ids: list[str] = field(default_factory=list)
    order_ids: list[str] = field(default_factory=list)
    batch_ids: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, list[str]]:
        return {"paymentIds": self.payment_ids, "orderIds": self.order_ids, "batchIds": self.batch_ids}


def _fee_for(gross_minor: int, fee_bps: int, merchant: WorldMerchant) -> tuple[int, int, int]:
    fee = bps_of(gross_minor, fee_bps) + merchant.fee_fixed_minor
    tax = bps_of(fee, merchant.tax_bps)
    return fee, tax, gross_minor - fee - tax


class ScenarioContext:
    def __init__(self, tx: AsyncSession, ids: IdGenerator, now: datetime, world: World) -> None:
        self.tx = tx
        self.ids = ids
        self.now = now
        self.world = world
        self.created = Created()
        self._pending: list[PendingLine] = []

    def queue_settlement(self, line: PendingLine) -> None:
        self._pending.append(line)

    async def flush_settlements(self) -> None:
        """Writes the gateway settlement file (one batch per group and merchant) and our internal settlement record. The gateway settles T+1 after the last
        capture in the batch."""
        groups: dict[str, list[PendingLine]] = {}
        for line in self._pending:
            groups.setdefault(f"{line.group}|{line.merchant.id}", []).append(line)
        self._pending.clear()
        for lines in groups.values():
            merchant = lines[0].merchant
            batch_id = self.ids.next("settlementBatch")
            settled_on = max(line.captured_at for line in lines) + timedelta(milliseconds=MERCHANT_CYCLE_MS)
            expected_net = reported_net = 0
            for i, line in enumerate(lines):
                fee, tax, net = _fee_for(line.gross_minor, line.fee_bps, merchant)
                expected_net += _fee_for(line.gross_minor, merchant.fee_bps, merchant)[2]
                reported_net += net
                self.tx.add(
                    GwSettlementLine(
                        id=self.ids.next("settlementLine"), batch_id=batch_id, merchant_id=merchant.id, gw_payment_id=line.gw_payment_id, gross_minor=line.gross_minor,
                        fee_minor=fee, tax_minor=tax, net_minor=net, line_no=i + 1, settled_on=settled_on, created_at=settled_on,
                    )
                )
            await self.tx.flush()
            self.tx.add(
                Settlement(
                    id=batch_id, merchant_id=merchant.id, settled_on=settled_on, payment_ids=[line.payment_id for line in lines if line.payment_id is not None],
                    expected_net_minor=expected_net, reported_net_minor=reported_net, status="PENDING", created_at=settled_on, updated_at=settled_on,
                )
            )
            await self.tx.flush()
            self.created.batch_ids.append(batch_id)
