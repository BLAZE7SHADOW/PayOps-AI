"""Fixed-window rate limiter kept in the database, so limits survive a restart and hold across several server processes.
One atomic upsert per attempt: it starts a new window when the old one has ended, otherwise adds one, and returns the
new count."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.engine import transaction
from ..db.models import AuthRateLimit
from ..errors import AppError
from ..ports import Clock


class RateLimiter:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], clock: Clock) -> None:
        self._sessions = sessions
        self._clock = clock

    async def hit(self, key: str, limit: int, window_ms: int, message: str) -> None:
        """Counts one attempt for `key`; raises RATE_LIMITED once more than `limit` happen in `window_ms`. Commits on
        its own, so a refused attempt counts."""
        now = self._clock.now()
        reset_at = now + timedelta(milliseconds=window_ms)
        stmt = text(
            """
            INSERT INTO auth_rate_limits (key, count, reset_at) VALUES (:key, 1, :reset_at)
            ON CONFLICT (key) DO UPDATE SET
              count = CASE WHEN auth_rate_limits.reset_at <= :now THEN 1 ELSE auth_rate_limits.count + 1 END,
              reset_at = CASE WHEN auth_rate_limits.reset_at <= :now THEN :reset_at ELSE auth_rate_limits.reset_at END
            RETURNING count
            """
        )
        async with transaction(self._sessions) as s:
            count = (await s.execute(stmt, {"key": key, "reset_at": reset_at, "now": now})).scalar_one()
        if count > limit:
            raise AppError("RATE_LIMITED", message)

    async def clear(self, key: str) -> None:
        """Forgets a key, for example after a successful sign-in."""
        async with transaction(self._sessions) as s:
            await s.execute(delete(AuthRateLimit).where(AuthRateLimit.key == key))

    async def purge_expired(self) -> None:
        """Removes windows that ended long ago. Called now and then; not needed for correctness."""
        async with transaction(self._sessions) as s:
            await s.execute(delete(AuthRateLimit).where(AuthRateLimit.reset_at < self._clock.now()))
