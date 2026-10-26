"""The small operator writes: case notes, saved queue views, feedback on a diagnosis, and the agent switch. Each is one short transaction with its audit
row where the TypeScript service audited. (packages/core case-note, saved-view, feedback and agent-control services)"""

from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import AgentControl, AgentRun, Case, CaseNote, DiagnosisFeedback, SavedView
from ...domain.ids import new_id
from ...domain.timeutil import to_iso
from ...dto.api import AgentControlBody, AgentControlItem
from ...dto.runs import DiagnosisFeedbackBody, DiagnosisFeedbackItem
from ...dto.workflow import MAX_SAVED_VIEWS_PER_USER, OperatorNoteBody, OperatorNoteItem, SavedViewBody, SavedViewItem
from ...errors import AppError, not_found
from ...ports import Clock
from ..agent_control import ROW_ID, AgentControlService
from ..audit import AuditActor, AuditService, WriteContext, audit_from


class CaseNoteWriteService:
    """Operator notes (D068). Append-only: a note cannot be edited or deleted, so the case history stays trustworthy. Allowed on closed cases too,
    because follow-up ("bank confirmed the refund") often lands after resolution."""

    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def add(self, session: AsyncSession, case_id: str, body: OperatorNoteBody, user_id: str, user_name: str) -> OperatorNoteItem:
        case = await session.get(Case, case_id)
        if case is None:
            raise not_found("Case", case_id)
        row = CaseNote(id=new_id("note"), case_id=case_id, text_=body.text, author_id=user_id, author_name=user_name, created_at=self._clock.now())
        session.add(row)
        await session.flush()
        await self._audit.record(
            session,
            audit_from(
                WriteContext(AuditActor("USER", user_id, user_name), case_id), action="case.note_added", entity_type="case", entity_id=case_id,
                summary=f"Added a note to {case.display_id}", after={"noteId": row.id},
            ),
        )
        return OperatorNoteItem(id=row.id, case_id=row.case_id, text=row.text_, author_id=row.author_id, author_name=row.author_name, created_at=to_iso(row.created_at))


class SavedViewWriteService:
    """Saved queue views (D068): a name plus a set of filters, private to one user."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock

    async def save(self, session: AsyncSession, owner_id: str, body: SavedViewBody) -> SavedViewItem:
        count = (await session.execute(select(func.count()).select_from(SavedView).where(SavedView.owner_id == owner_id))).scalar_one()
        if count >= MAX_SAVED_VIEWS_PER_USER:
            raise AppError("CONFLICT", f"You can keep up to {MAX_SAVED_VIEWS_PER_USER} saved views. Delete one first.")
        row = SavedView(id=new_id("savedView"), owner_id=owner_id, name=body.name, filters=body.filters.to_json(), created_at=self._clock.now())
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
        except IntegrityError as err:
            if getattr(err.orig, "sqlstate", None) == "23505":
                raise AppError("CONFLICT", f'You already have a view named "{body.name}".') from err
            raise
        return SavedViewItem(id=row.id, name=row.name, filters=row.filters, created_at=to_iso(row.created_at))

    async def remove(self, session: AsyncSession, owner_id: str, view_id: str) -> None:
        """Only the owner can delete a view; anyone else gets NOT_FOUND so ids are not probeable."""
        deleted = (await session.execute(delete(SavedView).where(SavedView.id == view_id, SavedView.owner_id == owner_id).returning(SavedView.id))).all()
        if not deleted:
            raise not_found("Saved view", view_id)


class FeedbackService:
    """Operator feedback on a run's diagnosis (D065). It only records a judgment: it never changes the run, the case or any later decision."""

    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def submit(self, session: AsyncSession, run_id: str, body: DiagnosisFeedbackBody, user_id: str, user_name: str) -> DiagnosisFeedbackItem:
        """Records the operator's verdict on a run. A second call from the same operator replaces the first."""
        run = await session.get(AgentRun, run_id)
        if run is None:
            raise AppError("NOT_FOUND", "Run not found")
        if not run.diagnosis:
            raise AppError("CONFLICT", "This run has no diagnosis to give feedback on yet.")
        now = self._clock.now()
        # A RIGHT verdict has nothing to correct, so a stray corrected cause is dropped.
        correct = body.correct_root_cause if body.verdict == "WRONG" else None
        values = {
            "diagnosed_root_cause": run.diagnosis["rootCause"], "verdict": body.verdict, "reason": body.reason, "correct_root_cause": correct,
            "given_by_name": user_name, "updated_at": now,
        }
        stmt = (
            pg_insert(DiagnosisFeedback)
            .values(id=new_id("diagnosisFeedback"), run_id=run_id, case_id=run.case_id, given_by_id=user_id, created_at=now, **values)
            .on_conflict_do_update(index_elements=[DiagnosisFeedback.run_id, DiagnosisFeedback.given_by_id], set_=values)
            .returning(DiagnosisFeedback)
        )
        row = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one()
        verdict_text = (
            f"Marked the diagnosis {run.diagnosis['rootCause']} as right." if body.verdict == "RIGHT"
            else f"Marked the diagnosis {run.diagnosis['rootCause']} as wrong: {body.reason}"
        )
        await self._audit.record(
            session,
            audit_from(
                WriteContext(AuditActor("USER", user_id, user_name), run.case_id, run_id), action="diagnosis.feedback", entity_type="run", entity_id=run_id,
                summary=verdict_text, after={"verdict": body.verdict, "correctRootCause": correct},
            ),
        )
        return DiagnosisFeedbackItem(
            id=row.id, run_id=row.run_id, case_id=row.case_id, diagnosed_root_cause=row.diagnosed_root_cause, verdict=row.verdict, reason=row.reason,
            correct_root_cause=row.correct_root_cause, given_by_id=row.given_by_id, given_by_name=row.given_by_name, created_at=to_iso(row.created_at),
            updated_at=to_iso(row.updated_at),
        )


class AgentControlWriteService:
    """The operator's switch for the agent (D066). Policy rule P12 enforces it; this only stores the setting. People are never affected by it."""

    def __init__(self, clock: Clock, audit: AuditService, reader: AgentControlService) -> None:
        self._clock = clock
        self._audit = audit
        self._reader = reader

    async def set(self, session: AsyncSession, body: AgentControlBody, user_id: str, user_name: str) -> AgentControlItem:
        now = self._clock.now()
        # Going back to NORMAL leaves nothing to explain, so an old reason is never shown by mistake.
        reason = "" if body.mode == "NORMAL" else body.reason
        values = {"mode": body.mode, "reason": reason, "changed_by_id": user_id, "changed_by_name": user_name, "updated_at": now}
        await session.execute(pg_insert(AgentControl).values(id=ROW_ID, **values).on_conflict_do_update(index_elements=[AgentControl.id], set_=values))
        await self._audit.record(
            session,
            audit_from(
                WriteContext(AuditActor("USER", user_id, user_name)), action="agent.control_changed", entity_type="agent", entity_id=ROW_ID,
                summary="Set the agent back to NORMAL." if body.mode == "NORMAL" else f"Set the agent to {body.mode}: {reason}",
                after={"mode": body.mode, "reason": reason},
            ),
        )
        await session.flush()
        return await self._reader.get(session)
