# pyright: reportArgumentType=false, reportCallIssue=false
"""Test database: one embedded Postgres per session, migrated once, cloned for each test that asks for it."""

from __future__ import annotations

import gzip
import itertools
import json
import logging
import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import psycopg
import pytest
import pytest_asyncio
from pgserver.postgres_server import get_server
from psycopg.types.json import Jsonb
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.db.engine import create_engine
from payops.db.migrate import upgrade

# Tests build the app many times and have no job worker: jobs run inline in the background of the same process.
os.environ.setdefault("JOBS", "inline")
os.environ.setdefault("CHECKPOINTER", "memory")

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


CONTRACT_DIR = Path(__file__).parent / "contract"


def load_contract_dump() -> dict:  # type: ignore[type-arg]
    return json.loads(gzip.open(CONTRACT_DIR / "db.json.gz").read())  # type: ignore[no-any-return]


@pytest.fixture(scope="session")
def seeded_template_uri(pg_uri: str, template_uri: str) -> str:
    """A database holding the recorded TypeScript scenarios (20 cases, runs, approvals), cloned by tests that need realistic data."""
    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute("CREATE DATABASE payops_seeded TEMPLATE payops_template")
    url = _with_database(pg_uri, "payops_seeded")
    with psycopg.connect(url, autocommit=True) as conn:
        # The dump is consistent, but tables load in alphabetical order, so foreign keys are not checked while it loads.
        conn.execute("SET session_replication_role = replica")
        for table, rows in load_contract_dump()["tables"].items():
            for row in rows:
                conn.execute(f'INSERT INTO "{table}" SELECT * FROM jsonb_populate_record(NULL::"{table}", %s)', [Jsonb(row)])
    return url


@pytest_asyncio.fixture
async def seeded_url(pg_uri: str, seeded_template_uri: str) -> AsyncIterator[str]:
    """A private copy of the seeded database for one test that changes data."""
    name = f"seeded_{next(_counter)}"
    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}" TEMPLATE payops_seeded')
    try:
        yield _with_database(pg_uri, name)
    finally:
        with psycopg.connect(pg_uri, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


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
