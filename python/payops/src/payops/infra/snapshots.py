"""Batched loading of OrderSnapshots and settlement batches. The number of queries is constant (about fifteen) no matter how many orders are
requested, so list endpoints and the sweep never do N+1 reads. (packages/core snapshot.loader.ts)"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from datetime import datetime, timedelta
from typing import Any, TypeVar

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Case, Customer, Device, Dispute, LedgerEntry, Merchant, Order, Payment, PaymentAttempt, Refund, Settlement
from ..domain.actions.types import BatchData, BatchState, CaseState
from ..domain.gateway import GatewaySettlementLine, PaymentGateway
from ..domain.reconciliation.rules import RULE_THRESHOLDS
from ..domain.reconciliation.settlement import check_batch
from ..domain.snapshot import OrderSnapshot, pick_primary_gw
from ..domain.timeutil import DAY_MS
from ..errors import not_found

T = TypeVar("T")
RISK_WINDOW = timedelta(milliseconds=RULE_THRESHOLDS.risk_window_ms)


def group_by(items: Iterable[T], key: Callable[[T], str | None]) -> dict[str, list[T]]:
    out: dict[str, list[T]] = {}
    for item in items:
        k = key(item)
        if k is not None:
            out.setdefault(k, []).append(item)
    return out


def _uniq(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


async def load_order_snapshots(session: AsyncSession, gateway: PaymentGateway, order_ids: Sequence[str], now: datetime) -> list[OrderSnapshot]:
    """Snapshots in the order of `order_ids`; unknown ids are skipped."""
    ids = _uniq(order_ids)
    if not ids:
        return []
    order_rows = (await session.scalars(select(Order).where(Order.id.in_(ids)))).all()
    payment_rows = (await session.scalars(select(Payment).where(Payment.order_id.in_(ids)))).all()
    gw_rows = await gateway.list_payments_by_order(ids)
    if not order_rows:
        return []

    payment_ids = [p.id for p in payment_rows]
    gw_ids = [g.id for g in gw_rows]
    merchant_ids = _uniq(o.merchant_id for o in order_rows)
    customer_ids = _uniq(o.customer_id for o in order_rows)
    earliest = min([now, *[g.captured_at for g in gw_rows if g.captured_at]]) - RISK_WINDOW

    webhooks = await gateway.list_webhook_deliveries(gw_ids)
    gw_refund_rows = await gateway.list_refunds(gw_ids)
    lines = await gateway.list_settlement_lines(gw_payment_ids=gw_ids)

    refund_rows: list[Refund] = list((await session.scalars(select(Refund).where(Refund.gw_payment_id.in_(gw_ids)))).all()) if gw_ids else []
    # Capture postings by internal payment, plus refund postings for any of the order's gateway payments (a refunded duplicate capture has a refund
    # journal but no internal payment).
    ledger_conditions: list[Any] = []
    if payment_ids:
        ledger_conditions.append(LedgerEntry.payment_id.in_(payment_ids))
    if gw_ids:
        ledger_conditions.append(LedgerEntry.refund_id.in_(select(Refund.id).where(Refund.gw_payment_id.in_(gw_ids))))
    ledger_rows = list((await session.scalars(select(LedgerEntry).where(or_(*ledger_conditions)))).all()) if ledger_conditions else []
    merchant_rows = (await session.scalars(select(Merchant).where(Merchant.id.in_(merchant_ids)))).all()
    customer_rows = (await session.scalars(select(Customer).where(Customer.id.in_(customer_ids)))).all()
    attempt_rows = (
        await session.scalars(
            select(PaymentAttempt).where(
                and_(PaymentAttempt.customer_id.in_(customer_ids), PaymentAttempt.at >= earliest, PaymentAttempt.at < now + timedelta(milliseconds=DAY_MS))
            )
        )
    ).all()
    device_rows = (await session.scalars(select(Device).where(Device.customer_id.in_(customer_ids)))).all()

    batch_ids = _uniq(line.batch_id for line in lines)
    settlement_rows = (await session.scalars(select(Settlement).where(Settlement.id.in_(batch_ids)))).all() if batch_ids else []

    # Merchant exposure: every settlement batch belonging to these merchants, then every dispute raised against any of them. This is the closest
    # signal the schema has to how often a merchant's money has been disputed (a merchant-level proxy, not a per-customer chargeback history).
    merchant_batches = (await session.execute(select(Settlement.id, Settlement.merchant_id).where(Settlement.merchant_id.in_(merchant_ids)))).all()
    merchant_by_batch = {bid: mid for bid, mid in merchant_batches}
    dispute_rows = (
        (await session.scalars(select(Dispute).where(Dispute.batch_id.in_(_uniq(merchant_by_batch))))).all() if merchant_by_batch else []
    )
    disputes_by_merchant = group_by(dispute_rows, lambda d: merchant_by_batch.get(d.batch_id))

    payments_by_order = group_by(payment_rows, lambda p: p.order_id)
    gw_by_order = group_by(gw_rows, lambda g: g.order_ref)
    webhooks_by_gw = group_by(webhooks, lambda w: w.gw_payment_id)
    gw_refunds_by_gw = group_by(gw_refund_rows, lambda r: r.gw_payment_id)
    lines_by_gw = group_by(lines, lambda line: line.gw_payment_id)
    ledger_by_payment = group_by(ledger_rows, lambda e: e.payment_id)
    ledger_by_refund = group_by(ledger_rows, lambda e: e.refund_id)
    refunds_by_gw = group_by(refund_rows, lambda r: r.gw_payment_id)
    attempts_by_customer = group_by(attempt_rows, lambda a: a.customer_id)
    devices_by_customer = group_by(device_rows, lambda d: d.customer_id)
    merchant_by_id = {m.id: m for m in merchant_rows}
    customer_by_id = {c.id: c for c in customer_rows}
    settlement_by_id = {s.id: s for s in settlement_rows}
    order_by_id = {o.id: o for o in order_rows}

    snapshots: list[OrderSnapshot] = []
    for oid in ids:
        order = order_by_id.get(oid)
        if order is None:
            continue
        merchant, customer = merchant_by_id.get(order.merchant_id), customer_by_id.get(order.customer_id)
        if merchant is None or customer is None:
            continue
        order_payments = payments_by_order.get(oid, [])
        payment = next((p for p in order_payments if p.id == order.payment_id), None) or (
            sorted(order_payments, key=lambda p: p.created_at, reverse=True)[0] if order_payments else None
        )
        gateway_payments = sorted(gw_by_order.get(oid, []), key=lambda g: g.created_at)
        primary = pick_primary_gw(gateway_payments, payment)
        order_lines: list[GatewaySettlementLine] = [line for g in gateway_payments for line in lines_by_gw.get(g.id, [])]
        primary_line = next((line for line in order_lines if primary and line.gw_payment_id == primary.id), None)
        window_end = (primary.captured_at if primary and primary.captured_at else now)
        window_start = window_end - RISK_WINDOW

        order_refunds = sorted((r for g in gateway_payments for r in refunds_by_gw.get(g.id, [])), key=lambda r: r.requested_at)
        ledger_by_id: dict[str, LedgerEntry] = {}
        for e in ledger_by_payment.get(payment.id, []) if payment else []:
            ledger_by_id[e.id] = e
        for r in order_refunds:
            for e in ledger_by_refund.get(r.id, []):
                ledger_by_id[e.id] = e

        snapshots.append(
            OrderSnapshot(
                now=now,
                order=order,
                payment=payment,
                gateway=gateway_payments,
                primary_gw=primary,
                webhooks=[w for g in gateway_payments for w in webhooks_by_gw.get(g.id, [])],
                ledger=sorted(ledger_by_id.values(), key=lambda e: (e.posted_at, e.id)),
                refunds=order_refunds,
                gw_refunds=[r for g in gateway_payments for r in gw_refunds_by_gw.get(g.id, [])],
                settlement_lines=order_lines,
                settlement=settlement_by_id.get(primary_line.batch_id) if primary_line else None,
                merchant=merchant,
                customer=customer,
                recent_attempts=sorted(
                    (a for a in attempts_by_customer.get(customer.id, []) if window_start <= a.at < window_end), key=lambda a: a.at
                ),
                devices=devices_by_customer.get(customer.id, []),
                merchant_disputes=disputes_by_merchant.get(order.merchant_id, []),
            )
        )
    return snapshots


async def load_batches(session: AsyncSession, gateway: PaymentGateway, batch_ids: Sequence[str]) -> list[BatchData]:
    """Loads several settlement batches with a constant number of queries."""
    ids = _uniq(batch_ids)
    if not ids:
        return []
    settlement_rows = (await session.scalars(select(Settlement).where(Settlement.id.in_(ids)))).all()
    lines = await gateway.list_settlement_lines(batch_ids=ids)
    if not settlement_rows:
        return []
    gw_ids = _uniq(line.gw_payment_id for line in lines)
    merchant_rows = (await session.scalars(select(Merchant).where(Merchant.id.in_(_uniq(s.merchant_id for s in settlement_rows))))).all()
    payment_rows = (
        (await session.execute(select(Payment.id, Payment.order_id, Payment.gw_payment_id).where(Payment.gw_payment_id.in_(gw_ids)))).all() if gw_ids else []
    )
    dispute_rows = (await session.scalars(select(Dispute).where(Dispute.batch_id.in_(ids)))).all()
    disputes_by_batch = group_by(dispute_rows, lambda d: d.batch_id)
    merchant_by_id = {m.id: m for m in merchant_rows}
    lines_by_batch = group_by(lines, lambda line: line.batch_id)
    payments_by_gw = {gw: {"id": pid, "orderId": oid} for pid, oid, gw in payment_rows}
    settlement_by_id = {s.id: s for s in settlement_rows}
    out: list[BatchData] = []
    for bid in ids:
        settlement = settlement_by_id.get(bid)
        merchant = merchant_by_id.get(settlement.merchant_id) if settlement else None
        if settlement is None or merchant is None:
            continue
        out.append(BatchData(settlement, lines_by_batch.get(bid, []), merchant, payments_by_gw, disputes_by_batch.get(bid, [])))
    return out


async def load_batch(session: AsyncSession, gateway: PaymentGateway, batch_id: str) -> BatchData | None:
    batches = await load_batches(session, gateway, [batch_id])
    return batches[0] if batches else None


async def load_case_state(session: AsyncSession, gateway: PaymentGateway, case: str | Case, now: datetime) -> CaseState:
    """Loads a case and everything its actions may need, fresh from the database and the gateway."""
    if isinstance(case, str):
        row = await session.get(Case, case)
        if row is None:
            raise not_found("Case", case)
    else:
        row = case
    refs = row.entity_refs
    snapshots = await load_order_snapshots(session, gateway, [refs["orderId"]], now) if refs.get("orderId") else []
    batch = await load_batch(session, gateway, refs["batchId"]) if refs.get("batchId") else None
    return CaseState(
        now=now,
        case=row,
        order=snapshots[0] if snapshots else None,
        batch=BatchState(batch, check_batch(batch.settlement.id, batch.lines, batch.merchant, batch.disputes)) if batch else None,
    )
