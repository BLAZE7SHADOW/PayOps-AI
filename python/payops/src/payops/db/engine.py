"""The async database engine and sessions."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from ..settings import Settings, sqlalchemy_url


def create_engine(
    settings: Settings | None = None, *, url: str | None = None, pool_size: int | None = None
) -> AsyncEngine:
    resolved = url or (settings.sqlalchemy_url if settings else None)
    if resolved is None:
        raise ValueError("pass settings or a url")
    size = pool_size if pool_size is not None else (settings.pool_size if settings else 5)
    return create_async_engine(
        sqlalchemy_url(resolved),
        pool_size=size,
        max_overflow=0,
        pool_pre_ping=True,
        # Every query is a round trip to a hosted database, so connections are kept rather than reopened.
        pool_recycle=1800,
    )


def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def transaction(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """One unit of work: commits when the block ends cleanly, rolls back when it raises."""
    async with factory() as session, session.begin():
        yield session


async def ping(engine: AsyncEngine) -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("select 1"))
    except Exception:  # noqa: BLE001 - any failure means the database is not reachable
        return False
    return True
