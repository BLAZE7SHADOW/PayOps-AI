"""Retry for a genuine Postgres serialization failure (SQLSTATE 40001), the error a SERIALIZABLE or REPEATABLE READ transaction gets when it loses a
write-write race it cannot detect until commit. Standard guidance is to retry the whole transaction from scratch. Only 40001 is retried; a broken
query, a constraint violation or an outage fails at once. (packages/core db/retry.ts)"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

from sqlalchemy.exc import DBAPIError

T = TypeVar("T")


def is_serialization_failure(err: BaseException) -> bool:
    return isinstance(err, DBAPIError) and getattr(err.orig, "sqlstate", None) == "40001"


async def with_serialization_retry(fn: Callable[[], Awaitable[T]], *, attempts: int = 3, delay_ms: int = 25) -> T:
    """Runs `fn` (which must be safe to call again, for example a fresh transaction) while it keeps raising a 40001."""
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except Exception as err:
            if not is_serialization_failure(err) or attempt == attempts:
                raise
            await asyncio.sleep(delay_ms / 1000)
    raise AssertionError("unreachable")
