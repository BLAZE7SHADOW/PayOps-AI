"""LangGraph checkpointer: Postgres in production, in memory for local runs and tests.

The checkpoint tables live in their own schema (`checkpoints_py`), apart from the TypeScript service's
`checkpoints` schema, because the two libraries store state in different encodings. A run belongs to one
runtime for its whole life, so they never need to read each other's checkpoints.
"""

from __future__ import annotations

import os
from contextlib import AsyncExitStack
from typing import Any

SCHEMA = "checkpoints_py"
LOCAL_PGLITE_PORT = 54329


def _wants_postgres(database_url: str | None) -> bool:
    mode = os.environ.get("CHECKPOINTER")
    if mode in ("memory", "postgres"):
        return mode == "postgres"
    if not database_url:
        return False
    # `pnpm db:local` (PGlite) serves one connection, and the API already holds it.
    return f":{LOCAL_PGLITE_PORT}" not in database_url


async def create_checkpointer(stack: AsyncExitStack) -> Any:
    database_url = os.environ.get("DATABASE_URL")
    if not _wants_postgres(database_url):
        from langgraph.checkpoint.memory import InMemorySaver

        return InMemorySaver()

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg import AsyncConnection
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    assert database_url
    async with await AsyncConnection.connect(database_url, autocommit=True) as conn:
        await conn.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")

    async def configure(conn: AsyncConnection[Any]) -> None:
        await conn.execute(f"SET search_path TO {SCHEMA}")

    pool = AsyncConnectionPool(
        database_url,
        min_size=1,
        max_size=int(os.environ.get("CHECKPOINT_POOL_MAX", "3")),
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        configure=configure,
        open=False,
    )
    await pool.open()
    stack.push_async_callback(pool.close)
    saver = AsyncPostgresSaver(pool)  # type: ignore[arg-type]
    await saver.setup()
    return saver
