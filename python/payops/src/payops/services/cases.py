"""The read side of cases: the queue list, list items for a few cases, and the open case behind a payment. (packages/core case.service.ts)"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import and_, asc, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Case, Customer, Merchant, SupportNote, User
from ..domain.cursor import decode_cursor, encode_cursor, is_record
from ..domain.enums import OPEN_CASE_STATUSES
from ..domain.gateway import PaymentGateway
from ..domain.reconciliation.lifecycle import build_lifecycle
from ..domain.reconciliation.matrix import build_matrix
from ..domain.timeutil import is_overdue, to_iso
from ..dto.api import AssigneeRef, CaseListItem, CaseListQuery, CaseSignals, Page, PrimaryRef
from ..dto.case_detail import CaseCustomer, CaseDetail, CaseEntityRefs, CaseMerchant, CaseNote, CaseResolutionSummary
from ..dto.matrix import StateMatrix
from ..errors import not_found
from ..infra.snapshots import load_order_snapshots
from ..ports import Clock

if TYPE_CHECKING:
    from ..api.security import SessionUser
    from .resolutions import ResolutionQueryService

CLOSED_CASE_STATUSES = ("RESOLVED", "REJECTED")


def escape_like(text: str) -> str:
    """Escape LIKE/ILIKE wildcards in user input so a search is a literal prefix match."""
    return "".join(f"\\{c}" if c in "\\%_" else c for c in text)


def to_case_list_item(row: Case, assignee_name: str | None, now: datetime) -> CaseListItem:
    refs = row.entity_refs
    signals = row.signals or {}
    return CaseListItem(
        id=row.id,
        display_id=row.display_id,
        type=row.type,
        severity=row.severity,
        priority=row.priority,
        status=row.status,
        amount_minor=row.amount_minor,
        rule_ids=row.rule_ids,
        mismatched=row.mismatched,
        signals=CaseSignals(complaint_type=signals.get("complaintType"), urgent=signals.get("urgent"), quarantined=signals.get("quarantined")),
        opened_at=to_iso(row.opened_at),
        updated_at=to_iso(row.updated_at),
        assignee=AssigneeRef(id=row.assignee_id, name=assignee_name) if row.assignee_id and assignee_name else None,
        due_at=to_iso(row.due_at) if row.due_at else None,
        overdue=is_overdue(row.due_at, row.status in OPEN_CASE_STATUSES, now),
        primary_ref=PrimaryRef(
            payment_id=refs.get("paymentId"),
            order_id=refs.get("orderId"),
            batch_id=refs.get("batchId") if row.type == "SETTLEMENT_MISMATCH" else None,
        ),
    )


def _is_case_cursor(v: object) -> bool:
    return is_record(v) and isinstance(v.get("p"), (int, float)) and isinstance(v.get("o"), str) and isinstance(v.get("i"), str)  # type: ignore[union-attr]


class CaseQueryService:
    def __init__(self, clock: Clock, gateway: PaymentGateway | None = None) -> None:
        self._clock = clock
        self._gateway = gateway
        #: Set by the container once the resolution service exists (it needs this service for the closed statuses).
        self.resolutions: ResolutionQueryService | None = None

    async def list(self, session: AsyncSession, query: CaseListQuery) -> Page[CaseListItem]:
        """Queue order: priority desc, then oldest first. Keyset pagination."""
        now = self._clock.now()
        filters: list = []
        if query.scope == "open":
            filters.append(Case.status.in_(OPEN_CASE_STATUSES))
        if query.scope == "closed":
            filters.append(Case.status.in_(CLOSED_CASE_STATUSES))
        if query.status:
            filters.append(Case.status == query.status)
        if query.type:
            filters.append(Case.type == query.type)
        if query.severity:
            filters.append(Case.severity == query.severity)
        if query.assignee_id == "unassigned":
            filters.append(Case.assignee_id.is_(None))
        elif query.assignee_id:
            filters.append(Case.assignee_id == query.assignee_id)
        if query.overdue == "true":
            filters.extend([Case.status.in_(OPEN_CASE_STATUSES), Case.due_at < now])
        if query.q:
            prefix = f"{escape_like(query.q)}%"
            filters.append(
                or_(
                    Case.display_id.ilike(prefix),
                    Case.id.ilike(prefix),
                    Case.entity_refs["paymentId"].astext.ilike(prefix),
                    Case.entity_refs["orderId"].astext.ilike(prefix),
                )
            )

        cursor = decode_cursor(query.cursor, _is_case_cursor)
        page_filters = list(filters)
        if cursor:
            opened_at = datetime.fromisoformat(cursor["o"])
            page_filters.append(
                or_(
                    Case.priority < cursor["p"],
                    and_(Case.priority == cursor["p"], Case.opened_at > opened_at),
                    and_(Case.priority == cursor["p"], Case.opened_at == opened_at, Case.id > cursor["i"]),
                )
            )
        stmt = (
            select(Case, User.name)
            .join(User, User.id == Case.assignee_id, isouter=True)
            .where(*page_filters)
            .order_by(desc(Case.priority), asc(Case.opened_at), asc(Case.id))
            .limit(query.limit + 1)
        )
        rows = (await session.execute(stmt)).all()
        total = (await session.execute(select(func.count()).select_from(Case).where(*filters))).scalar_one()
        page = rows[: query.limit]
        last = page[-1][0] if page else None
        next_cursor = encode_cursor({"p": last.priority, "o": to_iso(last.opened_at), "i": last.id}) if len(rows) > query.limit and last is not None else None
        return Page[CaseListItem](items=[to_case_list_item(r, name, now) for r, name in page], next_cursor=next_cursor, total=total)

    async def open_cases_by_payment(self, session: AsyncSession, payment_ids: list[str]) -> dict[str, tuple[str, str]]:
        """Highest-priority open case per internal payment id, as (case id, display id)."""
        out: dict[str, tuple[str, str]] = {}
        if not payment_ids:
            return out
        payment_ref = Case.entity_refs["paymentId"].astext
        rows = (
            await session.execute(
                select(Case.id, Case.display_id, payment_ref)
                .where(and_(payment_ref.in_(payment_ids), Case.status.in_(OPEN_CASE_STATUSES)))
                .order_by(desc(Case.priority), asc(Case.opened_at))
            )
        ).all()
        for case_id, display_id, payment_id in rows:
            out.setdefault(payment_id, (case_id, display_id))
        return out

    async def list_items(self, session: AsyncSession, ids: list[str]) -> list[CaseListItem]:
        """List items for specific cases, in the order asked. Unknown ids are skipped."""
        if not ids:
            return []
        rows = (await session.execute(select(Case, User.name).join(User, User.id == Case.assignee_id, isouter=True).where(Case.id.in_(ids)))).all()
        now = self._clock.now()
        by_id = {c.id: to_case_list_item(c, name, now) for c, name in rows}
        return [by_id[i] for i in ids if i in by_id]

    async def get(self, session: AsyncSession, case_id: str, viewer: SessionUser | None = None) -> CaseDetail:
        found = (await session.execute(select(Case, User.name).join(User, User.id == Case.assignee_id, isouter=True).where(Case.id == case_id))).first()
        if found is None:
            raise not_found("Case", case_id)
        row, assignee_name = found
        refs = row.entity_refs
        assert self._gateway is not None
        now = self._clock.now()

        note_filters = [
            f
            for f in (
                SupportNote.payment_id == refs["paymentId"] if refs.get("paymentId") else None,
                SupportNote.order_id == refs["orderId"] if refs.get("orderId") else None,
            )
            if f is not None
        ]
        notes = (await session.scalars(select(SupportNote).where(or_(*note_filters)).order_by(asc(SupportNote.created_at)))).all() if note_filters else []
        customer = await session.get(Customer, refs["customerId"]) if refs.get("customerId") else None
        merchant = await session.get(Merchant, refs["merchantId"]) if refs.get("merchantId") else None
        snapshots = await load_order_snapshots(session, self._gateway, [refs["orderId"]], now) if refs.get("orderId") else []
        snapshot = snapshots[0] if snapshots else None
        resolution_view = await self.resolutions.view(session, row, viewer) if self.resolutions else _empty_view()

        # Batch cases have no order snapshot; their stored matrix is what was recorded when the case opened.
        matrix = (
            build_matrix(snapshot)
            if snapshot and row.type != "SETTLEMENT_MISMATCH"
            else StateMatrix.model_validate({"cells": row.matrix, "mismatched": row.mismatched})
        )
        base = to_case_list_item(row, assignee_name, now).model_dump()
        base["mismatched"] = matrix.mismatched
        return CaseDetail(
            **base,
            matrix=matrix,
            entity_refs=CaseEntityRefs.model_validate(
                {k: refs.get(k) for k in ("paymentId", "gwPaymentId", "orderId", "customerId", "merchantId", "refundId", "batchId")}
            ),
            customer=CaseCustomer(id=customer.id, name=customer.name, email_masked=customer.email_masked) if customer else None,
            merchant=CaseMerchant(id=merchant.id, name=merchant.name) if merchant else None,
            notes=[CaseNote(id=n.id, author_type=n.author_type, text=n.text_, quarantined=n.quarantined, at=to_iso(n.created_at)) for n in notes],
            lifecycle=build_lifecycle(snapshot) if snapshot else [],
            resolved_at=to_iso(row.resolved_at) if row.resolved_at else None,
            resolution=CaseResolutionSummary(by=row.resolution["by"], summary=row.resolution["summary"]) if row.resolution else None,
            resolution_view=resolution_view,
        )


def _empty_view():  # type: ignore[no-untyped-def]
    from ..dto.resolution import CaseResolutionView

    return CaseResolutionView(
        action_options=[], resolutions=[], pending_approval_id=None, can_propose=False, cannot_propose_reason="Resolution is not available."
    )
