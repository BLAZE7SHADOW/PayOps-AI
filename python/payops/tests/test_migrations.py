# pyright: reportArgumentType=false, reportCallIssue=false
import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.db.migrate import upgrade
from tests.conftest import _with_database


async def test_a_new_database_gets_every_table_and_the_audit_triggers(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        tables = (
            await conn.execute(text("select count(*) from information_schema.tables where table_schema = 'public'"))
        ).scalar()
        triggers = {r[0] for r in await conn.execute(text("select tgname from pg_trigger where not tgisinternal"))}
        revision = (await conn.execute(text("select version_num from alembic_version"))).scalar()
    assert tables == 39  # the 34 application tables, alembic_version and the 4 job queue tables
    assert {"audit_events_no_update", "audit_events_no_delete"} <= triggers
    assert revision == "0002"


async def test_the_audit_log_cannot_be_edited_or_deleted(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "insert into audit_events (id, actor_type, actor_id, actor_name, action, entity_type, entity_id, summary, seq, prev_hash, hash) "
                "values ('aud_1', 'SYSTEM', 'x', 'X', 'test', 'system', 'e', 'first', 1, '', 'h1')"
            )
        )
    for statement in ("update audit_events set summary = 'changed'", "delete from audit_events"):
        with pytest.raises(DBAPIError, match="append-only"):
            async with engine.begin() as conn:
                await conn.execute(text(statement))


def test_running_the_migration_twice_changes_nothing(database_url: str) -> None:
    upgrade(database_url)
    upgrade(database_url)
    with psycopg.connect(database_url) as conn:
        assert conn.execute("select count(*) from alembic_version").fetchone() == (1,)


def test_a_database_drizzle_already_built_is_adopted_not_rebuilt(pg_uri: str) -> None:
    """The hosted database was created by Drizzle, so it already has the tables and no `alembic_version`."""
    import pathlib

    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute('CREATE DATABASE "from_drizzle"')
    uri = _with_database(pg_uri, "from_drizzle")
    sql_dir = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "sql"
    with psycopg.connect(uri, autocommit=True) as conn:
        for file in sorted(sql_dir.glob("0*.sql")):
            for statement in file.read_text().split("--> statement-breakpoint"):
                if statement.strip():
                    conn.execute(statement)
    upgrade(uri)
    with psycopg.connect(uri) as conn:
        assert conn.execute("select version_num from alembic_version").fetchone() == ("0002",)
