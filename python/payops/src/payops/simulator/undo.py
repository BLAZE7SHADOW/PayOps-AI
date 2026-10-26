"""The "undo last reset" for the public demo. Before a reset wipes the demo data, the current rows are copied into a
side schema (`demo_undo`) with plain SQL; undo truncates the live tables and copies them back in foreign-key order.
Users are never touched. One level of undo: the next reset replaces the snapshot. The snapshot lives in the database, so
it survives an API restart. (packages/simulator undo.ts)"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.engine import transaction
from ..domain.timeutil import to_iso
from ..ports import Clock

SNAPSHOT_SCHEMA = "demo_undo"
#: Tables that hold accounts or migration state, never snapshotted or wiped. `auth_rate_limits` and `sessions` stay so a
#: reset does not sign anyone out.
KEEP = frozenset({"users", "sessions", "auth_rate_limits", "alembic_version"})
#: Job queue tables are kept too; they belong to the runtime, not to the demo data.
_KEEP_PREFIXES = ("procrastinate_",)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


async def demo_tables(s: AsyncSession) -> list[str]:
    rows = (
        (await s.execute(text("select tablename from pg_tables where schemaname = current_schema()"))).scalars().all()
    )
    return sorted(t for t in rows if t not in KEEP and not t.startswith(_KEEP_PREFIXES))


async def insert_order(s: AsyncSession, tables: list[str]) -> list[str]:
    """Parent-first order from foreign keys, so restores never insert a child before its parent."""
    rows = (
        await s.execute(
            text(
                """
                select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
                from pg_constraint c
                where c.contype = 'f' and c.connamespace = current_schema()::regnamespace
                """
            )
        )
    ).all()

    def clean(name: str) -> str:
        name = name.strip('"')
        return name.split(".", 1)[1].strip('"') if "." in name else name

    known = set(tables)
    deps: dict[str, set[str]] = {t: set() for t in tables}
    for child, parent in rows:
        c, p = clean(child), clean(parent)
        if c != p and c in known and p in known:
            deps[c].add(p)
    ordered: list[str] = []
    remaining = set(tables)
    while remaining:
        ready = [t for t in remaining if not (deps[t] & remaining)]
        # A cycle should not exist; if one does, fall through and insert the rest in name order.
        batch = sorted(ready) if ready else sorted(remaining)
        ordered.extend(batch)
        remaining.difference_update(batch)
    return ordered


@dataclass(frozen=True)
class UndoStatus:
    can_undo: bool
    #: ISO time the snapshot was taken (when the last reset started).
    snapshot_at: str | None

    def to_json(self) -> dict[str, object]:
        return {"canUndo": self.can_undo, "snapshotAt": self.snapshot_at}


async def undo_status(s: AsyncSession) -> UndoStatus:
    exists = (await s.execute(text("select to_regclass(:name)"), {"name": f"{SNAPSHOT_SCHEMA}._meta"})).scalar_one()
    if not exists:
        return UndoStatus(False, None)
    taken_at = (await s.execute(text(f"select taken_at from {SNAPSHOT_SCHEMA}._meta limit 1"))).scalar_one_or_none()
    if taken_at is None:
        return UndoStatus(False, None)
    return UndoStatus(True, to_iso(taken_at))


async def snapshot_demo_data(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> None:
    """Copies every demo table into the side schema, replacing any earlier snapshot."""
    async with transaction(sessions) as s:
        tables = await demo_tables(s)
        await s.execute(text(f"drop schema if exists {SNAPSHOT_SCHEMA} cascade"))
        await s.execute(text(f"create schema {SNAPSHOT_SCHEMA}"))
        for t in tables:
            await s.execute(text(f"create table {SNAPSHOT_SCHEMA}.{_quote(t)} as table {_quote(t)}"))
        await s.execute(text(f"create table {SNAPSHOT_SCHEMA}._meta (taken_at timestamptz not null)"))
        await s.execute(text(f"insert into {SNAPSHOT_SCHEMA}._meta (taken_at) values (:at)"), {"at": clock.now()})


async def undo_last_reset(sessions: async_sessionmaker[AsyncSession]) -> None:
    """Restores the snapshot taken before the last reset. Raises if there is nothing to restore."""
    async with transaction(sessions) as s:
        if not (await undo_status(s)).can_undo:
            raise RuntimeError("There is no reset to undo.")
        tables = await demo_tables(s)
        snapshotted = set(
            (
                await s.execute(
                    text("select tablename from pg_tables where schemaname = :schema"), {"schema": SNAPSHOT_SCHEMA}
                )
            )
            .scalars()
            .all()
        )
        restorable = [t for t in tables if t in snapshotted]
        await s.execute(text(f"truncate {', '.join(_quote(t) for t in restorable)} cascade"))
        for t in await insert_order(s, restorable):
            await s.execute(text(f"insert into {_quote(t)} select * from {SNAPSHOT_SCHEMA}.{_quote(t)}"))
        await s.execute(text(f"drop schema {SNAPSHOT_SCHEMA} cascade"))
