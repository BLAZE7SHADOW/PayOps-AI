"""Runs detection: loads snapshots, stores each payment's matrix verdict, and opens or updates cases. Each case write
(plus its audit row) is one transaction; realtime events go out only after the commit so the UI never sees a case that
was rolled back. (packages/core reconciliation.service.ts)"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import Order, Payment, Settlement
from ...domain.gateway import PaymentGateway
from ...domain.reconciliation.candidates import CaseCandidate, evaluate_order, group_hits, snapshot_entity_refs
from ...domain.reconciliation.matrix import blank_matrix, build_matrix
from ...domain.reconciliation.settlement import check_batch
from ...domain.timeutil import DAY_MS, to_iso
from ...dto.api import CaseListItem
from ...infra.snapshots import load_batches, load_order_snapshots
from ...ports import Clock, EventPublisher
from ...realtime import ROOM_OPS, OpsEvents
from ..cases import CaseQueryService
from .cases import CaseWriteService

RECON_CHUNK_SIZE = 200

#: J1 signal intake hook: screens a newly opened case's support notes once, outside the transaction (it makes a network
#: call).
ScreenCase = Callable[[str, dict[str, Any]], Awaitable[Any]]


@dataclass
class TouchedCase:
    case: CaseListItem
    created: bool


@dataclass
class ReconciliationSummary:
    checked: int = 0
    opened: int = 0
    updated: int = 0
    cases: list[TouchedCase] = field(default_factory=list)

    def merge(self, other: ReconciliationSummary) -> None:
        self.checked += other.checked
        self.opened += other.opened
        self.updated += other.updated
        self.cases.extend(other.cases)


def _chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


class ReconciliationService:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        clock: Clock,
        gateway: PaymentGateway,
        cases: CaseWriteService,
        case_queries: CaseQueryService,
        events: EventPublisher,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._gateway = gateway
        self._cases = cases
        self._case_queries = case_queries
        self._events = events
        self.screen_case: ScreenCase | None = None

    async def check_orders(self, order_ids: list[str]) -> ReconciliationSummary:
        """Re-evaluates the given orders: updates payments.recon and opens or updates cases."""
        summary = ReconciliationSummary()
        for chunk in _chunks(list(dict.fromkeys(order_ids)), RECON_CHUNK_SIZE):
            summary.merge(await self._check_order_chunk(chunk))
        return summary

    async def _check_order_chunk(self, order_ids: list[str]) -> ReconciliationSummary:
        now = self._clock.now()
        async with self._sessions() as s:
            snapshots = await load_order_snapshots(s, self._gateway, order_ids, now)
        recon_rows: list[tuple[str, dict[str, Any], bool]] = []
        candidates: list[CaseCandidate] = []
        clean: list[str] = []
        for snap in snapshots:
            evaluation = evaluate_order(snap)
            if snap.payment:
                recon_rows.append(
                    (
                        snap.payment.id,
                        {"mismatched": evaluation.matrix.mismatched, "checkedAt": to_iso(now)},
                        bool(evaluation.matrix.mismatched),
                    )
                )
            candidates.extend(evaluation.candidates)
            if not evaluation.hits and not evaluation.matrix.mismatched:
                clean.append(snap.order.id)
        await self._save_recon(recon_rows)
        result = await self._apply_candidates(candidates)
        # D069: an order that now has no rule hit and no mismatched system closes its OPEN cases.
        closed = await self._cases.auto_close_reconciled(self._sessions, clean)
        if closed:
            async with self._sessions() as s:
                for item in await self._case_queries.list_items(s, closed):
                    self._events.publish(ROOM_OPS, OpsEvents.CASE_UPDATED, item.to_json())
        result.checked = len(snapshots)
        return result

    async def _save_recon(self, rows: list[tuple[str, dict[str, Any], bool]]) -> None:
        if not rows:
            return
        async with transaction(self._sessions) as s:
            for payment_id, recon, mismatch in rows:
                await s.execute(update(Payment).where(Payment.id == payment_id).values(recon=recon, mismatch=mismatch))

    async def check_batches(self, batch_ids: list[str]) -> ReconciliationSummary:
        """Re-checks settlement batches (rule D7)."""
        summary = ReconciliationSummary()
        for chunk in _chunks(list(dict.fromkeys(batch_ids)), RECON_CHUNK_SIZE):
            summary.merge(await self._check_batch_chunk(chunk))
        return summary

    async def _check_batch_chunk(self, batch_ids: list[str]) -> ReconciliationSummary:
        now = self._clock.now()
        async with self._sessions() as s:
            batches = await load_batches(s, self._gateway, batch_ids)
            checks = [(b, check_batch(b.settlement.id, b.lines, b.merchant, b.disputes)) for b in batches]
            # The case links to the first offending line's payment so the case page has a lifecycle.
            offending_orders: list[str] = []
            for batch, result in checks:
                gw_id = result.offending_lines[0].line.gw_payment_id if result.hit and result.offending_lines else None
                payment = batch.payments_by_gw.get(gw_id) if gw_id else None
                if payment is not None:
                    offending_orders.append(payment["orderId"])
            snapshots = await load_order_snapshots(s, self._gateway, offending_orders, now)
        snapshot_by_gw = {g.id: snap for snap in snapshots for g in snap.gateway}

        candidates: list[CaseCandidate] = []
        async with transaction(self._sessions) as s:
            for batch, result in checks:
                await s.execute(
                    update(Settlement)
                    .where(Settlement.id == batch.settlement.id)
                    .values(
                        expected_net_minor=result.expected_net_minor,
                        reported_net_minor=result.reported_net_minor,
                        status="MATCHED" if result.diff_minor == 0 else "MISMATCH",
                        updated_at=now,
                    )
                )
                if not result.hit:
                    continue
                gw_id = result.offending_lines[0].line.gw_payment_id if result.offending_lines else None
                snap = snapshot_by_gw.get(gw_id) if gw_id else None
                matrix = (
                    build_matrix(snap)
                    if snap
                    else blank_matrix(
                        {"SETTLEMENT": {"status": "NET MISMATCH", "mismatch": True, "detail": result.hit.reason}}
                    )
                )
                refs = snapshot_entity_refs(snap) if snap else {"merchantId": batch.merchant.id}
                if snap and gw_id:
                    refs["gwPaymentId"] = gw_id
                candidates.extend(group_hits([result.hit], refs, matrix))
        summary = await self._apply_candidates(candidates)
        summary.checked = len(batches)
        return summary

    async def sweep(self, since_days: int = 30) -> ReconciliationSummary:
        """Periodic full check: every order and settlement batch from the last `since_days` days, in chunks so memory
        stays flat."""
        since = self._clock.now() - timedelta(milliseconds=since_days * DAY_MS)
        summary = ReconciliationSummary()
        for model, handler in ((Order, self._check_order_chunk), (Settlement, self._check_batch_chunk)):
            after_id = ""
            date_column = Order.created_at if model is Order else Settlement.settled_on
            while True:
                async with self._sessions() as s:
                    ids = list(
                        (
                            await s.scalars(
                                select(model.id)
                                .where(date_column >= since, model.id > after_id)
                                .order_by(model.id)
                                .limit(RECON_CHUNK_SIZE)
                            )
                        ).all()
                    )
                if not ids:
                    break
                summary.merge(await handler(ids))
                after_id = ids[-1]
                if len(ids) < RECON_CHUNK_SIZE:
                    break
        return summary

    async def _apply_candidates(self, candidates: list[CaseCandidate]) -> ReconciliationSummary:
        summary = ReconciliationSummary()
        touched: list[tuple[str, bool]] = []
        for candidate in candidates:
            async with transaction(self._sessions) as s:
                result = await self._cases.open_or_update(s, candidate)
            if result.created:
                summary.opened += 1
            else:
                summary.updated += 1
            if result.changed:
                touched.append((result.case.id, result.created))
            # J1 signal intake: screen a newly opened case's support notes once, outside the DB transaction, before the
            # case is published to the UI.
            if result.created and self.screen_case is not None:
                refs = result.case.entity_refs
                await self.screen_case(
                    result.case.id, {"paymentId": refs.get("paymentId"), "orderId": refs.get("orderId")}
                )
        # After commit: publish only what changed, so a sweep over stable data is silent.
        async with self._sessions() as s:
            items = {i.id: i for i in await self._case_queries.list_items(s, [t[0] for t in touched])}
        for case_id, created in touched:
            item = items.get(case_id)
            if item is None:
                continue
            summary.cases.append(TouchedCase(item, created))
            self._events.publish(
                ROOM_OPS, OpsEvents.CASE_CREATED if created else OpsEvents.CASE_UPDATED, item.to_json()
            )
        return summary
