"""Approval queue reads. (The decision itself is a write and lives with the executor in Phase B4.) (packages/core
approval.service.ts)"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Approval, Case, Resolution
from ..domain.cursor import decode_cursor, encode_cursor, is_record
from ..domain.enums import role_at_least
from ..domain.money import format_money
from ..domain.permissions import has_permission
from ..domain.timeutil import parse_iso, to_iso
from ..dto.actions import ACTION_META
from ..dto.api import Page
from ..dto.case_detail import ApprovalDetail
from ..dto.policy import APPROVER_ROLE
from ..dto.resolution import ApprovalCase, ApprovalItem, ApprovalListQuery
from ..errors import not_found
from ..ports import Clock
from .cases import CaseQueryService
from .resolutions import ResolutionQueryService

if TYPE_CHECKING:
    from ..api.security import SessionUser


def actions_summary(actions: list[dict]) -> str:
    return " · ".join(
        f"{ACTION_META[a['type']].label} {format_money(a['params']['amountMinor'])}"
        if a["type"] == "INITIATE_REFUND"
        else ACTION_META[a["type"]].label
        for a in actions
    )


def cannot_decide_reason(approval: Approval, resolution: Resolution, viewer: SessionUser | None) -> str | None:
    """Why this viewer cannot decide, or None if they can."""
    if approval.status != "PENDING":
        return f"Already {approval.status.lower()}."
    if viewer is None:
        return "Sign in to decide."
    needed = APPROVER_ROLE[approval.tier]
    allowed = has_permission(viewer.role, "approval.decide") and (
        needed != "MANAGER" or role_at_least(viewer.role, "MANAGER")
    )
    if not allowed:
        return "Needs a manager." if needed == "MANAGER" else "Needs an OPS user or above."
    if resolution.proposed_by["type"] == "USER" and resolution.proposed_by["id"] == viewer.id:
        return "You proposed this resolution. Another person must approve it."
    return None


def _is_approval_cursor(v: object) -> bool:
    return is_record(v) and isinstance(v.get("at"), str) and isinstance(v.get("id"), str)  # type: ignore[union-attr]


def to_approval_item(a: Approval, c: Case, r: Resolution, viewer: SessionUser | None) -> ApprovalItem:
    reason = cannot_decide_reason(a, r, viewer)
    return ApprovalItem(
        id=a.id,
        case=ApprovalCase(id=c.id, display_id=c.display_id, type=c.type, status=c.status, amount_minor=c.amount_minor),
        resolution_id=r.id,
        tier=a.tier,
        status=a.status,
        actions_summary=actions_summary(r.actions),
        action_types=[x["type"] for x in r.actions],
        money_moving_minor=r.policy["moneyMovingMinor"],
        risk_tier=r.policy["riskTier"],
        rule_ids=[x["ruleId"] for x in r.policy["reasons"]],
        requested_by=a.requested_by,
        requested_at=to_iso(a.requested_at),
        decided_by=a.decided_by,
        decided_at=to_iso(a.decided_at) if a.decided_at else None,
        comment=a.comment,
        can_decide=reason is None,
        cannot_decide_reason=reason,
    )


class ApprovalQueryService:
    def __init__(self, clock: Clock, cases: CaseQueryService, resolutions: ResolutionQueryService) -> None:
        self._clock = clock
        self._cases = cases
        self._resolutions = resolutions

    async def _load(self, session: AsyncSession, approval_id: str) -> tuple[Approval, Case, Resolution]:
        row = (
            await session.execute(
                select(Approval, Case, Resolution)
                .join(Case, Case.id == Approval.case_id)
                .join(Resolution, Resolution.id == Approval.resolution_id)
                .where(Approval.id == approval_id)
            )
        ).first()
        if row is None:
            raise not_found("Approval", approval_id)
        return row[0], row[1], row[2]

    async def list(
        self, session: AsyncSession, query: ApprovalListQuery, viewer: SessionUser | None
    ) -> Page[ApprovalItem]:
        """Newest request first, keyset-paginated."""
        filters: list = []
        if query.scope == "pending":
            filters.append(Approval.status == "PENDING")
        if query.scope == "decided":
            filters.append(Approval.status != "PENDING")
        page_filters = list(filters)
        cursor = decode_cursor(query.cursor, _is_approval_cursor)
        if cursor:
            at = parse_iso(cursor["at"])
            page_filters.append(
                or_(Approval.requested_at < at, and_(Approval.requested_at == at, Approval.id < cursor["id"]))
            )
        rows = (
            await session.execute(
                select(Approval, Case, Resolution)
                .join(Case, Case.id == Approval.case_id)
                .join(Resolution, Resolution.id == Approval.resolution_id)
                .where(*page_filters)
                .order_by(desc(Approval.requested_at), desc(Approval.id))
                .limit(query.limit + 1)
            )
        ).all()
        total = (await session.execute(select(func.count()).select_from(Approval).where(*filters))).scalar_one()
        page = rows[: query.limit]
        last = page[-1][0] if page else None
        next_cursor = (
            encode_cursor({"at": to_iso(last.requested_at), "id": last.id})
            if len(rows) > query.limit and last is not None
            else None
        )
        return Page[ApprovalItem](
            items=[to_approval_item(a, c, r, viewer) for a, c, r in page], next_cursor=next_cursor, total=total
        )

    async def item(self, session: AsyncSession, approval_id: str, viewer: SessionUser | None = None) -> ApprovalItem:
        """One approval as a list item (viewer-independent when viewer is None, for realtime fan-out)."""
        a, c, r = await self._load(session, approval_id)
        return to_approval_item(a, c, r, viewer)

    async def get(self, session: AsyncSession, approval_id: str, viewer: SessionUser | None) -> ApprovalDetail:
        a, c, r = await self._load(session, approval_id)
        resolution = await self._resolutions.item(session, r.id)
        case_item = (await self._cases.list_items(session, [c.id]))[0]
        return ApprovalDetail(
            **to_approval_item(a, c, r, viewer).model_dump(), resolution=resolution, case_item=case_item
        )

    async def pending_count(self, session: AsyncSession) -> int:
        return (
            await session.execute(select(func.count()).select_from(Approval).where(Approval.status == "PENDING"))
        ).scalar_one()
