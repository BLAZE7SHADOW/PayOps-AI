"""Operator workflow reads: the shift handoff, case notes and saved queue views. (packages/core handoff.service.ts,
case-note.service.ts, saved-view.service.ts)"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import asc, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Case, CaseNote, SavedView, User
from ..domain.enums import ACTOR_TYPES, OPEN_CASE_STATUSES, SEVERITIES
from ..domain.timeutil import is_overdue, to_iso
from ..dto.workflow import (
    HandoffCaseRef,
    HandoffNote,
    HandoffOpen,
    HandoffRecentNote,
    HandoffResolved,
    HandoffSummary,
    OperatorNoteItem,
    SavedViewItem,
)
from ..errors import not_found
from ..ports import Clock

MAX_ATTENTION = 10
MAX_RECENT_NOTES = 10


class HandoffService:
    """Everything here is counted and ordered by code from the database; no model writes or rewords any of it (rule
    4)."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock

    async def summary(self, session: AsyncSession, since_hours: int) -> HandoffSummary:
        now = self._clock.now()
        since = now - timedelta(hours=since_hours)
        open_rows = (
            await session.execute(
                select(Case, User.name)
                .join(User, User.id == Case.assignee_id, isouter=True)
                .where(Case.status.in_(OPEN_CASE_STATUSES))
            )
        ).all()

        by_severity = {s: 0 for s in SEVERITIES}
        overdue = awaiting = unassigned = 0
        attention: list[tuple[int, float, HandoffCaseRef]] = []
        for row, assignee_name in open_rows:
            by_severity[row.severity] += 1
            late = is_overdue(row.due_at, True, now)
            overdue += late
            awaiting += row.status == "AWAITING_APPROVAL"
            unassigned += not row.assignee_id
            reasons = [
                *(["Overdue"] if late else []),
                *(["Critical"] if row.severity == "CRITICAL" else []),
                *(["Waiting for approval"] if row.status == "AWAITING_APPROVAL" else []),
                *(["Escalated"] if row.status == "ESCALATED" else []),
            ]
            if not reasons:
                continue
            ref = HandoffCaseRef(
                id=row.id,
                display_id=row.display_id,
                type=row.type,
                severity=row.severity,
                status=row.status,
                amount_minor=row.amount_minor,
                due_at=to_iso(row.due_at) if row.due_at else None,
                overdue=late,
                assignee_name=assignee_name,
                reasons=reasons,
                last_note=None,
            )
            attention.append((row.priority, row.opened_at.timestamp(), ref))
        # Same order as the queue: priority high to low, then oldest first.
        attention.sort(key=lambda a: (-a[0], a[1]))
        top = [a[2] for a in attention[:MAX_ATTENTION]]

        last_notes: dict[str, HandoffNote] = {}
        if top:
            notes = (
                await session.scalars(
                    select(CaseNote)
                    .where(CaseNote.case_id.in_([t.id for t in top]))
                    .order_by(desc(CaseNote.created_at), desc(CaseNote.id))
                )
            ).all()
            for n in notes:
                last_notes.setdefault(
                    n.case_id, HandoffNote(text=n.text_, author_name=n.author_name, at=to_iso(n.created_at))
                )
        resolved_rows = (
            await session.execute(select(Case.resolution).where(Case.status == "RESOLVED", Case.resolved_at >= since))
        ).all()
        resolved_by = {a: 0 for a in ACTOR_TYPES}
        for (resolution,) in resolved_rows:
            if resolution:
                resolved_by[resolution["by"]] += 1
        recent = (
            await session.execute(
                select(CaseNote, Case.display_id)
                .join(Case, Case.id == CaseNote.case_id)
                .where(CaseNote.created_at >= since)
                .order_by(desc(CaseNote.created_at), desc(CaseNote.id))
                .limit(MAX_RECENT_NOTES)
            )
        ).all()
        return HandoffSummary(
            generated_at=to_iso(now),
            since_hours=since_hours,
            since=to_iso(since),
            open=HandoffOpen(
                total=len(open_rows),
                overdue=overdue,
                awaiting_approval=awaiting,
                unassigned=unassigned,
                by_severity=by_severity,
            ),
            needs_attention=[t.model_copy(update={"last_note": last_notes.get(t.id)}) for t in top],
            resolved=HandoffResolved(total=len(resolved_rows), by=resolved_by),
            recent_notes=[
                HandoffRecentNote(
                    case_id=n.case_id,
                    display_id=display_id,
                    text=n.text_,
                    author_name=n.author_name,
                    at=to_iso(n.created_at),
                )
                for n, display_id in recent
            ],
        )


class CaseNoteQueryService:
    async def list(self, session: AsyncSession, case_id: str) -> list[OperatorNoteItem]:
        """Newest first."""
        if (await session.get(Case, case_id)) is None:
            raise not_found("Case", case_id)
        rows = (
            await session.scalars(
                select(CaseNote)
                .where(CaseNote.case_id == case_id)
                .order_by(desc(CaseNote.created_at), desc(CaseNote.id))
            )
        ).all()
        return [
            OperatorNoteItem(
                id=r.id,
                case_id=r.case_id,
                text=r.text_,
                author_id=r.author_id,
                author_name=r.author_name,
                created_at=to_iso(r.created_at),
            )
            for r in rows
        ]


class SavedViewQueryService:
    async def list(self, session: AsyncSession, owner_id: str) -> list[SavedViewItem]:
        rows = (
            await session.scalars(
                select(SavedView)
                .where(SavedView.owner_id == owner_id)
                .order_by(asc(SavedView.created_at), asc(SavedView.id))
            )
        ).all()
        return [SavedViewItem(id=r.id, name=r.name, filters=r.filters, created_at=to_iso(r.created_at)) for r in rows]
