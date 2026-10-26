"""The audit hash chain in the database (packages/core audit/store.ts): appending one row at a time, reading the chain
in pages, and sealing rows written before the chain existed."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import asc, desc, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AuditEvent
from ..domain.audit import GENESIS_HASH, ChainFields, ChainRow, compute_audit_hash

#: Arbitrary constant. One transaction-scoped advisory lock serialises every audit append so seq and prev_hash never
#: fork.
AUDIT_APPEND_LOCK = 7_701_012


def _fields(row: AuditEvent, *, seq: int | None = None, prev_hash: str | None = None) -> ChainFields:
    return ChainFields(
        seq=row.seq if seq is None else seq,
        id=row.id,
        at=row.at,
        actor_type=row.actor_type,
        actor_id=row.actor_id,
        actor_name=row.actor_name,
        action=row.action,
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        summary=row.summary,
        before=row.before,
        after=row.after,
        run_id=row.run_id,
        case_id=row.case_id,
        prev_hash=row.prev_hash if prev_hash is None else prev_hash,
    )


async def append_audit_row(session: AsyncSession, row: AuditEvent) -> None:
    """Appends one row to the chain. Must run inside a transaction: the lock is released at commit, so the chain order
    is the commit order."""
    await session.execute(text("select pg_advisory_xact_lock(:k)"), {"k": AUDIT_APPEND_LOCK})
    last = (
        await session.execute(select(AuditEvent.seq, AuditEvent.hash).order_by(desc(AuditEvent.seq)).limit(1))
    ).first()
    row.seq = (last[0] if last else 0) + 1
    row.prev_hash = (last[1] if last and last[1] else None) or GENESIS_HASH
    row.hash = compute_audit_hash(_fields(row))
    session.add(row)
    await session.flush()


async def read_chain_page(session: AsyncSession, after_seq: int, limit: int) -> Sequence[AuditEvent]:
    """Rows in chain order, `limit` at a time, after `after_seq`."""
    return (
        await session.scalars(
            select(AuditEvent).where(AuditEvent.seq > after_seq).order_by(asc(AuditEvent.seq)).limit(limit)
        )
    ).all()


def to_chain_row(r: AuditEvent) -> ChainRow:
    return ChainRow(**{**_fields(r).__dict__, "hash": r.hash})


async def seal_legacy_audit_rows(session: AsyncSession) -> int:
    """Gives a hash to rows written before the chain existed (migration 0012 numbered them). Does nothing once every row
    is sealed. The only UPDATE the append-only trigger allows is on a row whose hash is still empty."""
    await session.execute(text("select pg_advisory_xact_lock(:k)"), {"k": AUDIT_APPEND_LOCK})
    legacy = (
        await session.scalars(select(AuditEvent).where(AuditEvent.hash == "").order_by(asc(AuditEvent.seq)))
    ).all()
    if not legacy:
        return 0
    before = (
        await session.execute(
            select(AuditEvent.hash).where(AuditEvent.seq < legacy[0].seq).order_by(desc(AuditEvent.seq)).limit(1)
        )
    ).scalar()
    prev_hash = before or GENESIS_HASH
    for r in legacy:
        digest = compute_audit_hash(_fields(r, prev_hash=prev_hash))
        await session.execute(update(AuditEvent).where(AuditEvent.id == r.id).values(prev_hash=prev_hash, hash=digest))
        prev_hash = digest
    return len(legacy)


async def count_rows(session: AsyncSession) -> Any:
    return (await session.execute(select(func.count()).select_from(AuditEvent))).scalar_one()
