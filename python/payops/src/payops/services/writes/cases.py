"""Case writes: opening and merging cases from detection, status changes, auto-close, assignment. (packages/core
case.service.ts)"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Case, Counter, User
from ...domain.enums import CASE_DISPLAY_PREFIX, CASE_TYPE_LABEL, OPEN_CASE_STATUSES, SEVERITY_RANK
from ...domain.gateway import PaymentGateway
from ...domain.ids import case_display_id, new_id
from ...domain.money import format_money
from ...domain.permissions import has_permission
from ...domain.reconciliation.candidates import CaseCandidate, priority_of
from ...domain.reconciliation.matrix import build_matrix
from ...domain.timeutil import due_at_for
from ...errors import AppError, not_found
from ...infra.snapshots import load_order_snapshots
from ...ports import Clock
from ..audit import SYSTEM_ACTOR, AuditInput, AuditService, WriteContext, audit_from
from ..cases import CLOSED_CASE_STATUSES, to_case_list_item

#: Audit action names for case status changes.
CASE_STATUS_ACTION = {
    "OPEN": "case.reopened",
    "INVESTIGATING": "case.investigating",
    "AWAITING_APPROVAL": "case.awaiting_approval",
    "EXECUTING": "case.executing",
    "RESOLVED": "case.resolved",
    "ESCALATED": "case.escalated",
    "REJECTED": "case.rejected",
}

_UNSET: Any = object()

#: Case types that may close themselves when the data reconciles (D069).
AUTO_CLOSE_CASE_TYPES = ("PAYMENT_MISMATCH", "REFUND_EXCEPTION", "DUPLICATE")
OPEN_FINGERPRINT_INDEX = "cases_open_fingerprint_uq"


def is_open_fingerprint_conflict(err: IntegrityError) -> bool:
    """Postgres unique violation on the one-open-case-per-fingerprint index."""
    orig = err.orig
    return (
        getattr(orig, "sqlstate", None) == "23505"
        and getattr(getattr(orig, "diag", None), "constraint_name", None) == OPEN_FINGERPRINT_INDEX
    )


@dataclass
class OpenOrUpdateResult:
    case: Case
    created: bool
    #: True when something an analyst would notice changed (new case, new rules, severity).
    changed: bool


class CaseWriteService:
    def __init__(self, clock: Clock, audit: AuditService, gateway: PaymentGateway | None = None) -> None:
        self._clock = clock
        self._audit = audit
        self._gateway = gateway

    async def open_or_update(self, session: AsyncSession, candidate: CaseCandidate) -> OpenOrUpdateResult:
        """Opens a case for the candidate or merges it into the open case with the same fingerprint. Runs inside the
        caller's transaction."""
        existing = await self._find_open(session, candidate.fingerprint)
        if existing is not None:
            return await self._merge(session, existing, candidate)
        try:
            # Savepoint: a unique violation must not abort the surrounding transaction.
            async with session.begin_nested():
                row = await self._insert(session, candidate)
        except IntegrityError as err:
            if not is_open_fingerprint_conflict(err):
                raise
            # Another writer opened it between our read and insert: merge into theirs.
            winner = await self._find_open(session, candidate.fingerprint)
            if winner is None:
                raise
            return await self._merge(session, winner, candidate)
        a = SYSTEM_ACTOR
        await self._audit.record(
            session,
            AuditInput(
                a.actor_type,
                a.actor_id,
                a.actor_name,
                "case.opened",
                "case",
                row.id,
                f"Opened {row.display_id}: {CASE_TYPE_LABEL[row.type]} for {format_money(row.amount_minor)} ({', '.join(row.rule_ids)})",
                after={"severity": row.severity, "ruleIds": row.rule_ids, "mismatched": row.mismatched},
                case_id=row.id,
            ),
        )
        return OpenOrUpdateResult(row, created=True, changed=True)

    async def _find_open(self, session: AsyncSession, fingerprint: str) -> Case | None:
        stmt = (
            select(Case)
            .where(Case.fingerprint == fingerprint, Case.status.notin_(CLOSED_CASE_STATUSES))
            .with_for_update()
            .limit(1)
        )
        return (await session.scalars(stmt.execution_options(populate_existing=True))).first()

    async def _next_display_id(self, session: AsyncSession, candidate: CaseCandidate) -> str:
        prefix = CASE_DISPLAY_PREFIX[candidate.type]
        stmt = (
            pg_insert(Counter)
            .values(id=f"case:{prefix}", seq=1)
            .on_conflict_do_update(index_elements=[Counter.id], set_={"seq": Counter.seq + 1})
            .returning(Counter.seq)
        )
        return case_display_id(prefix, (await session.execute(stmt)).scalar_one())

    async def _insert(self, session: AsyncSession, candidate: CaseCandidate) -> Case:
        now = self._clock.now()
        row = Case(
            id=new_id("case"),
            display_id=await self._next_display_id(session, candidate),
            fingerprint=candidate.fingerprint,
            type=candidate.type,
            severity=candidate.severity,
            priority=candidate.priority,
            status="OPEN",
            amount_minor=candidate.amount_minor,
            rule_ids=candidate.rule_ids,
            matrix={k: c.to_json() for k, c in candidate.matrix.cells.items()},
            mismatched=candidate.matrix.mismatched,
            entity_refs=candidate.entity_refs,
            signals={},
            last_detected_at=now,
            opened_at=now,
            due_at=due_at_for(candidate.severity, now),
            updated_at=now,
            assignee_id=None,
            active_run_id=None,
            resolution=None,
            resolved_at=None,
        )
        session.add(row)
        await session.flush()
        return row

    async def _merge(self, session: AsyncSession, existing: Case, candidate: CaseCandidate) -> OpenOrUpdateResult:
        rule_ids = sorted({*existing.rule_ids, *candidate.rule_ids})
        severity = (
            candidate.severity
            if SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]
            else existing.severity
        )
        rules_changed = len(rule_ids) != len(existing.rule_ids)
        changed = (
            rules_changed
            or severity != existing.severity
            or ",".join(candidate.matrix.mismatched) != ",".join(existing.mismatched)
        )
        now = self._clock.now()
        previous_rules, previous_severity = existing.rule_ids, existing.severity
        existing.rule_ids = rule_ids
        existing.severity = severity
        existing.priority = priority_of(severity, candidate.amount_minor)
        existing.amount_minor = candidate.amount_minor
        existing.matrix = {k: c.to_json() for k, c in candidate.matrix.cells.items()}
        existing.mismatched = candidate.matrix.mismatched
        existing.entity_refs = {**existing.entity_refs, **candidate.entity_refs}
        existing.last_detected_at = now
        # Only a visible change bumps updated_at, so the queue's "updated" column stays meaningful.
        if changed:
            existing.updated_at = now
        await session.flush()
        if rules_changed:
            a = SYSTEM_ACTOR
            await self._audit.record(
                session,
                AuditInput(
                    a.actor_type,
                    a.actor_id,
                    a.actor_name,
                    "case.updated",
                    "case",
                    existing.id,
                    f"{existing.display_id} matched more rules: {', '.join(rule_ids)}",
                    before={"ruleIds": previous_rules, "severity": previous_severity},
                    after={"ruleIds": rule_ids, "severity": severity},
                    case_id=existing.id,
                ),
            )
        return OpenOrUpdateResult(existing, created=False, changed=changed)

    async def auto_close_reconciled(self, session_factory: Any, clean_order_ids: list[str]) -> list[str]:
        """Closes OPEN cases whose order detection has just re-read and found fully consistent (D069). Only plain
        payment, refund and duplicate cases qualify: a case someone is working is theirs to close, and risk and
        settlement cases stay open because "nothing flagged now" does not prove a risk or a batch difference is gone.
        Closes as RESOLVED by SYSTEM with a stated reason; returns the closed case ids."""
        from ...db.engine import transaction

        if not clean_order_ids:
            return []
        async with session_factory() as s:
            order_ref = Case.entity_refs["orderId"].astext
            candidates = (
                await s.scalars(
                    select(Case).where(
                        Case.status == "OPEN", Case.type.in_(AUTO_CLOSE_CASE_TYPES), order_ref.in_(clean_order_ids)
                    )
                )
            ).all()
        closed: list[str] = []
        for c in candidates:
            async with transaction(session_factory) as s:
                # Re-check under the row lock: someone may have picked the case up since the query.
                locked = (await s.scalars(select(Case.status).where(Case.id == c.id).with_for_update())).first()
                if locked != "OPEN":
                    continue
                await self.set_status(
                    s,
                    c.id,
                    "RESOLVED",
                    f"{c.display_id}: closed automatically, all systems agree again",
                    WriteContext(SYSTEM_ACTOR, c.id),
                    resolution={
                        "by": "SYSTEM",
                        "summary": "Reconciled without action: all systems agree again.",
                        "runId": None,
                    },
                )
            await self.refresh_stored_matrix(session_factory, c.id)
            closed.append(c.id)
        return closed

    async def refresh_stored_matrix(self, session_factory: Any, case_id: str) -> None:
        """Recomputes the matrix stored on a case from fresh data, so the queue and the case page agree. Batch cases
        keep their detection-time matrix (D012)."""
        assert self._gateway is not None
        async with session_factory() as s:
            row = await s.get(Case, case_id)
            if row is None or row.type == "SETTLEMENT_MISMATCH" or not row.entity_refs.get("orderId"):
                return
            snapshots = await load_order_snapshots(s, self._gateway, [row.entity_refs["orderId"]], self._clock.now())
        if not snapshots:
            return
        matrix = build_matrix(snapshots[0])
        async with session_factory.begin() as s:
            await s.execute(
                update(Case)
                .where(Case.id == case_id)
                .values(
                    matrix={k: c.to_json() for k, c in matrix.cells.items()},
                    mismatched=matrix.mismatched,
                    updated_at=self._clock.now(),
                )
            )

    async def assign(
        self, session: AsyncSession, case_id: str, assignee_id: str | None, actor_id: str, actor_name: str
    ) -> Any:
        """Assigns an open case to an OPS-or-above user, or clears the assignee with None. The same assignee twice is a
        no-op with no audit row."""
        existing = (
            await session.scalars(
                select(Case).where(Case.id == case_id).with_for_update().execution_options(populate_existing=True)
            )
        ).one_or_none()
        if existing is None:
            raise not_found("Case", case_id)
        if existing.status not in OPEN_CASE_STATUSES:
            raise AppError("CONFLICT", f"{existing.display_id} is {existing.status.lower()} and cannot be reassigned")
        assignee: User | None = None
        if assignee_id is not None:
            assignee = await session.get(User, assignee_id)
            if assignee is None:
                raise not_found("User", assignee_id)
            if not has_permission(assignee.role, "case.assign"):
                raise AppError(
                    "VALIDATION_FAILED", f"{assignee.name} cannot be assigned cases (needs the OPS role or above)"
                )
        now = self._clock.now()
        if existing.assignee_id == assignee_id:
            return to_case_list_item(existing, assignee.name if assignee else None, now)
        previous = await session.get(User, existing.assignee_id) if existing.assignee_id else None
        before = existing.assignee_id
        existing.assignee_id = assignee_id
        existing.updated_at = now
        await session.flush()
        summary = (
            f"Assigned {existing.display_id} to {assignee.name}"
            if assignee
            else f"Unassigned {existing.display_id}{f' (was {previous.name})' if previous else ''}"
        )
        await self._audit.record(
            session,
            AuditInput(
                "USER",
                actor_id,
                actor_name,
                "case.assigned" if assignee else "case.unassigned",
                "case",
                case_id,
                summary,
                before={"assigneeId": before},
                after={"assigneeId": assignee_id},
                case_id=case_id,
            ),
        )
        return to_case_list_item(existing, assignee.name if assignee else None, now)

    async def set_status(
        self,
        session: AsyncSession,
        case_id: str,
        status: str,
        summary: str,
        ctx: WriteContext,
        *,
        resolution: dict[str, Any] | None = _UNSET,
    ) -> Case:
        """Moves a case to a new status and audits it when the status actually changed. Used by the resolution flow
        (AWAITING_APPROVAL, EXECUTING, RESOLVED...) and the ESCALATE action."""
        row = (
            await session.scalars(
                select(Case).where(Case.id == case_id).with_for_update().execution_options(populate_existing=True)
            )
        ).one_or_none()
        if row is None:
            raise not_found("Case", case_id)
        previous = row.status
        now = self._clock.now()
        closing = status in CLOSED_CASE_STATUSES
        row.status = status
        row.updated_at = now
        row.resolved_at = now if status == "RESOLVED" else (row.resolved_at if closing else None)
        if resolution is not _UNSET:
            row.resolution = resolution
        await session.flush()
        if previous != status:
            after: dict[str, Any] = {"status": status}
            if resolution is not _UNSET and resolution:
                after["resolution"] = resolution
            await self._audit.record(
                session,
                audit_from(
                    WriteContext(ctx.actor, case_id, ctx.run_id),
                    action=CASE_STATUS_ACTION[status],
                    entity_type="case",
                    entity_id=case_id,
                    summary=summary,
                    before={"status": previous},
                    after=after,
                ),
            )
        return row
