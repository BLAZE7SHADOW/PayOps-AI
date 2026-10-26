"""Read side of the payments explorer. Pages are selected with one keyset query, then every row is built from batched OrderSnapshots, so the list's
ledger, settlement and mismatch columns are computed by the same code as the case page's state matrix. (packages/core payment-query.service.ts)"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime

from sqlalchemy import and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import GwPayment, Order, Payment
from ..domain.cursor import decode_cursor, encode_cursor, is_record
from ..domain.gateway import PaymentGateway
from ..domain.reconciliation.lifecycle import build_lifecycle
from ..domain.reconciliation.matrix import LEDGER_CODES, SETTLEMENT_CODES, build_matrix
from ..domain.snapshot import OrderSnapshot
from ..domain.timeutil import to_iso
from ..dto.api import CardInfo, MerchantRef, OpenCaseRef, Page, PaymentDetail, PaymentListItem, PaymentListQuery, PersonRef
from ..dto.matrix import StateMatrix
from ..errors import not_found
from ..infra.snapshots import load_order_snapshots
from ..ports import Clock
from .cases import CaseQueryService, escape_like


def ledger_state(matrix: StateMatrix) -> str:
    status = matrix.cells["LEDGER"].status
    if status == LEDGER_CODES["posted"]:
        return "POSTED"
    if status == LEDGER_CODES["notExpected"]:
        return "NOT_EXPECTED"
    return "MISSING"


def settlement_state(matrix: StateMatrix) -> str:
    status = matrix.cells["SETTLEMENT"].status
    if status == SETTLEMENT_CODES["settled"]:
        return "SETTLED"
    if status == SETTLEMENT_CODES["feeMismatch"]:
        return "MISMATCH"
    if status == SETTLEMENT_CODES["pending"]:
        return "PENDING"
    return "NOT_EXPECTED"


def _is_payment_cursor(v: object) -> bool:
    return is_record(v) and isinstance(v.get("c"), str) and isinstance(v.get("i"), str)  # type: ignore[union-attr]


def _parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text)


class PaymentQueryService:
    def __init__(self, clock: Clock, gateway: PaymentGateway, cases: CaseQueryService) -> None:
        self._clock = clock
        self._gateway = gateway
        self._cases = cases

    async def list(self, session: AsyncSession, query: PaymentListQuery) -> Page[PaymentListItem]:
        """Newest first, keyset-paginated on (created_at, id)."""
        conditions: list = []
        q = (query.q or "").strip()
        if q:
            pattern = f"{escape_like(q)}%"
            conditions.append(or_(Payment.id.ilike(pattern), Payment.gw_payment_id.ilike(pattern), Payment.order_id.ilike(pattern)))
        if query.gateway_status:
            # A read-side filter on the gateway mirror table; writes still go only through the adapter.
            conditions.append(Payment.gw_payment_id.in_(select(GwPayment.id).where(GwPayment.status == query.gateway_status)))
        if query.order_status:
            conditions.append(Payment.order_id.in_(select(Order.id).where(Order.status == query.order_status)))
        if query.mismatch_only == "true":
            conditions.append(Payment.mismatch.is_(True))
        if query.from_:
            conditions.append(Payment.created_at >= _parse_iso(query.from_))
        if query.to:
            conditions.append(Payment.created_at <= _parse_iso(query.to))
        cursor = decode_cursor(query.cursor, _is_payment_cursor)
        if cursor:
            c = _parse_iso(cursor["c"])
            conditions.append(or_(Payment.created_at < c, and_(Payment.created_at == c, Payment.id < cursor["i"])))

        rows = list(
            (await session.scalars(select(Payment).where(*conditions).order_by(desc(Payment.created_at), desc(Payment.id)).limit(query.limit + 1))).all()
        )
        page = rows[: query.limit]
        items = await self._build_items(session, page)
        last = page[-1] if page else None
        next_cursor = encode_cursor({"c": to_iso(last.created_at), "i": last.id}) if len(rows) > query.limit and last else None
        return Page[PaymentListItem](items=items, next_cursor=next_cursor)

    async def get(self, session: AsyncSession, id_: str) -> PaymentDetail:
        """Accepts our payment id or the gateway payment id."""
        payment = (await session.scalars(select(Payment).where(or_(Payment.id == id_, Payment.gw_payment_id == id_)).limit(1))).first()
        if payment is None:
            raise not_found("Payment", id_)
        snapshots = await load_order_snapshots(session, self._gateway, [payment.order_id], self._clock.now())
        if not snapshots:
            raise not_found("Payment", id_)
        snapshot = snapshots[0]
        open_cases = await self._cases.open_cases_by_payment(session, [payment.id])
        item, matrix = self._to_item(payment, snapshot, open_cases.get(payment.id))
        gw = next((g for g in snapshot.gateway if g.id == payment.gw_payment_id), None)
        card = CardInfo(last4=gw.card["last4"], network=gw.card["network"], country=gw.card["country"]) if gw and gw.card else None
        return PaymentDetail(**item.model_dump(), card=card, lifecycle=build_lifecycle(snapshot), matrix=matrix)

    async def _build_items(self, session: AsyncSession, page: list[Payment]) -> list[PaymentListItem]:
        if not page:
            return []
        snapshots = await load_order_snapshots(session, self._gateway, [p.order_id for p in page], self._clock.now())
        open_cases = await self._cases.open_cases_by_payment(session, [p.id for p in page])
        by_order = {s.order.id: s for s in snapshots}
        return [self._to_item(p, by_order[p.order_id], open_cases.get(p.id))[0] for p in page if p.order_id in by_order]

    def _to_item(self, payment: Payment, snapshot: OrderSnapshot, open_case: tuple[str, str] | None) -> tuple[PaymentListItem, StateMatrix]:
        view = snapshot if snapshot.payment is not None and snapshot.payment.id == payment.id else replace(snapshot, payment=payment)
        matrix = build_matrix(view)
        gw = next((g for g in view.gateway if g.id == payment.gw_payment_id), None) or view.primary_gw
        item = PaymentListItem(
            payment_id=payment.id,
            gw_payment_id=payment.gw_payment_id,
            order_id=payment.order_id,
            created_at=to_iso(payment.created_at),
            customer=PersonRef(id=view.customer.id, name=view.customer.name, email_masked=view.customer.email_masked),
            merchant=MerchantRef(id=view.merchant.id, name=view.merchant.name),
            amount_minor=payment.amount_minor,
            method=payment.method,
            gateway_status=gw.status if gw else "CREATED",
            internal_status=payment.status,
            order_status=view.order.status,
            ledger=ledger_state(matrix),  # type: ignore[arg-type]
            settlement=settlement_state(matrix),  # type: ignore[arg-type]
            mismatch=len(matrix.mismatched) > 0,
            open_case=OpenCaseRef(id=open_case[0], display_id=open_case[1]) if open_case else None,
        )
        return item, matrix
