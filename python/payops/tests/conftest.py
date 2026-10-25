# pyright: reportArgumentType=false, reportCallIssue=false
"""Test database: one embedded Postgres per session, migrated once, cloned for each test that asks for it."""

from __future__ import annotations

import itertools
import logging
import tempfile
from collections.abc import AsyncIterator, Iterator

import psycopg
import pytest
import pytest_asyncio
from pgserver.postgres_server import get_server
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.db.engine import create_engine
from payops.db.migrate import upgrade

# pgserver logs from an exit hook after pytest has closed stderr; the failure is harmless and only noisy.
logging.raiseExceptions = False

_counter = itertools.count()


@pytest.fixture(scope="session")
def pg_uri() -> Iterator[str]:
    """Base URI of a real Postgres started for this test run (the `pgserver` package, no Docker)."""
    with tempfile.TemporaryDirectory(prefix="payops-pg-") as data_dir:
        server = get_server(data_dir)
        uri = server.get_uri()
        with psycopg.connect(uri, autocommit=True) as conn:
            conn.execute("CREATE DATABASE payops_template")
        yield uri
        server.cleanup()


def _with_database(uri: str, name: str) -> str:
    # pgserver's URI is `postgresql://postgres:@/postgres?host=<socket dir>`.
    return uri.replace("/postgres?", f"/{name}?", 1)


@pytest.fixture(scope="session")
def template_uri(pg_uri: str) -> str:
    uri = _with_database(pg_uri, "payops_template")
    upgrade(uri)
    return uri


@pytest_asyncio.fixture
async def database_url(pg_uri: str, template_uri: str) -> AsyncIterator[str]:
    """A fresh, fully migrated database for one test, cloned from the template (a few milliseconds)."""
    name = f"test_{next(_counter)}"
    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}" TEMPLATE payops_template')
    try:
        yield _with_database(pg_uri, name)
    finally:
        with psycopg.connect(pg_uri, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest_asyncio.fixture
async def engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_engine(url=database_url, pool_size=3)
    try:
        yield eng
    finally:
        await eng.dispose()
