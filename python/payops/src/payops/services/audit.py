"""The append-only audit trail (packages/core audit.service.ts). Pass the caller's session so the audit row commits with
the change it describes."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import and_, asc, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AuditEvent
from ..domain.audit import GENESIS_HASH, csv_line, verify_audit_chain
from ..domain.cursor import decode_cursor, encode_cursor, is_record
from ..domain.ids import new_id
from ..domain.timeutil import to_iso
from ..dto.api import Page
from ..dto.audit import ActorRef, AuditChainStatus, AuditEventItem, AuditListQuery, ChainHead
from ..infra.audit_store import append_audit_row, read_chain_page, to_chain_row
from ..ports import Clock

VERIFY_PAGE = 1000
EXPORT_COLUMNS = [
    "seq",
    "id",
    "at",
    "actor_type",
    "actor_id",
    "actor_name",
    "action",
    "entity_type",
    "entity_id",
    "case_id",
    "run_id",
    "summary",
    "before",
    "after",
    "prev_hash",
    "hash",
]


@dataclass(frozen=True)
class AuditActor:
    actor_type: str
    actor_id: str
    actor_name: str


#: The actor used for automated detection and background jobs.
SYSTEM_ACTOR = AuditActor("SYSTEM", "system", "Reconciliation")
WEBHOOK_CONSUMER_ACTOR = AuditActor("SYSTEM", "webhook-consumer", "Webhook consumer")


@dataclass(frozen=True)
class WriteContext:
    """Who is making a write and on behalf of which case or run. Every write service takes one so its audit rows land in
    the case's trail."""

    actor: AuditActor
    case_id: str | None = None
    run_id: str | None = None


@dataclass
class AuditInput:
    actor_type: str
    actor_id: str
    actor_name: str
    action: str
    entity_type: str
    entity_id: str
    summary: str
    before: Any = None
    after: Any = None
    case_id: str | None = None
    run_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def audit_from(
    ctx: WriteContext,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    summary: str,
    before: Any = None,
    after: Any = None,
) -> AuditInput:
    """Convenience for writing an audit row from a WriteContext."""
    return AuditInput(
        ctx.actor.actor_type,
        ctx.actor.actor_id,
        ctx.actor.actor_name,
        action,
        entity_type,
        entity_id,
        summary,
        before,
        after,
        ctx.case_id,
        ctx.run_id,
    )


def to_audit_item(r: AuditEvent) -> AuditEventItem:
    return AuditEventItem(
        id=r.id,
        at=to_iso(r.at),
        actor_type=r.actor_type,
        actor=ActorRef(id=r.actor_id, name=r.actor_name),
        action=r.action,
        entity_type=r.entity_type,
        entity_id=r.entity_id,
        summary=r.summary,
        run_id=r.run_id,
    )


def _is_audit_cursor(v: object) -> bool:
    return is_record(v) and isinstance(v.get("at"), str) and isinstance(v.get("id"), str)  # type: ignore[union-attr]


class AuditService:
    def __init__(self, clock: Clock) -> None:
        self._clock = clock

    async def record(self, session: AsyncSession, inp: AuditInput) -> None:
        """Appends one row to the chain. The caller owns the transaction, so the row commits with the change it
        describes."""
        row = AuditEvent(
            id=new_id("audit"),
            at=self._clock.now(),
            actor_type=inp.actor_type,
            actor_id=inp.actor_id,
            actor_name=inp.actor_name,
            action=inp.action,
            entity_type=inp.entity_type,
            entity_id=inp.entity_id,
            summary=inp.summary,
            seq=0,
            prev_hash="",
            hash="",
            before=inp.before,
            after=inp.after,
            run_id=inp.run_id,
            case_id=inp.case_id,
        )
        await append_audit_row(session, row)

    async def verify_chain(
        self, session: AsyncSession, expected_head: tuple[int, str] | None = None
    ) -> AuditChainStatus:
        """Walks the whole chain in seq order and reports the first broken row (D077)."""
        after: tuple[int, str] | None = None
        checked = 0
        while True:
            page = await read_chain_page(session, after[0] if after else 0, VERIFY_PAGE)
            if not page:
                break
            verdict = verify_audit_chain([to_chain_row(r) for r in page], start_after=after)
            checked += verdict.checked
            if not verdict.ok:
                return self._status(False, checked, after, verdict.seq, verdict.id, verdict.reason)
            after = (page[-1].seq, page[-1].hash)
            if len(page) < VERIFY_PAGE:
                break
        if expected_head:
            verdict = verify_audit_chain([], start_after=after or (0, GENESIS_HASH), expected_head=expected_head)
            if not verdict.ok:
                return self._status(False, checked, after, None, None, verdict.reason)
        return self._status(True, checked, after, None, None, None)

    @staticmethod
    def _status(
        ok: bool, checked: int, head: tuple[int, str] | None, seq: int | None, id_: str | None, reason: str | None
    ) -> AuditChainStatus:
        return AuditChainStatus(
            ok=ok,
            checked=checked,
            head=ChainHead(seq=head[0], hash=head[1]) if head else None,
            broken_at_seq=seq,
            broken_id=id_,
            reason=reason,
        )

    async def export_csv(
        self, session: AsyncSession, case_id: str | None = None, entity_id: str | None = None
    ) -> AsyncIterator[str]:
        """CSV lines for the whole log (or one case or entity), oldest first, a page at a time so memory stays flat."""
        yield csv_line(EXPORT_COLUMNS)
        after_seq = 0
        while True:
            conditions = [AuditEvent.seq > after_seq]
            if case_id:
                conditions.append(AuditEvent.case_id == case_id)
            if entity_id:
                conditions.append(AuditEvent.entity_id == entity_id)
            rows = (
                await session.scalars(
                    select(AuditEvent).where(and_(*conditions)).order_by(asc(AuditEvent.seq)).limit(VERIFY_PAGE)
                )
            ).all()
            if not rows:
                return
            for r in rows:
                yield csv_line(
                    [
                        r.seq,
                        r.id,
                        to_iso(r.at),
                        r.actor_type,
                        r.actor_id,
                        r.actor_name,
                        r.action,
                        r.entity_type,
                        r.entity_id,
                        r.case_id,
                        r.run_id,
                        r.summary,
                        r.before,
                        r.after,
                        r.prev_hash,
                        r.hash,
                    ]
                )
            after_seq = rows[-1].seq
            if len(rows) < VERIFY_PAGE:
                return

    async def list(self, session: AsyncSession, query: AuditListQuery) -> Page[AuditEventItem]:
        """Newest first, keyset-paginated on (at, id)."""
        conditions: list = []
        if query.case_id:
            conditions.append(AuditEvent.case_id == query.case_id)
        if query.entity_id:
            conditions.append(AuditEvent.entity_id == query.entity_id)
        cursor = decode_cursor(query.cursor, _is_audit_cursor)
        if cursor:
            from datetime import datetime

            at = datetime.fromisoformat(cursor["at"])
            conditions.append(or_(AuditEvent.at < at, and_(AuditEvent.at == at, AuditEvent.id < cursor["id"])))
        rows = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(*conditions)
                    .order_by(desc(AuditEvent.at), desc(AuditEvent.id))
                    .limit(query.limit + 1)
                )
            ).all()
        )
        page = rows[: query.limit]
        last = page[-1] if page else None
        next_cursor = (
            encode_cursor({"at": to_iso(last.at), "id": last.id}) if len(rows) > query.limit and last else None
        )
        return Page[AuditEventItem](items=[to_audit_item(r) for r in page], next_cursor=next_cursor)
