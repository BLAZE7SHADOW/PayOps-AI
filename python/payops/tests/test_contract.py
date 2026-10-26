"""Contract tests: the Python API against responses recorded from the TypeScript API (D086).

`pnpm contract:export` runs the TypeScript backend on seeded data with a fixed clock and records every read-only response plus the database
rows. These tests load the same rows into a fresh Postgres, serve the same requests with the same clock and signed-in user, and require
identical JSON. A route that is not ported yet answers "No route" and is skipped; once all are ported nothing may be skipped.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
import pytest_asyncio
from psycopg.types.json import Jsonb

from payops.api.app import create_app
from payops.api.security import SessionUser
from payops.db.engine import create_engine
from payops.ports import FixedClock
from payops.settings import Settings
from tests.conftest import _with_database

HERE = Path(__file__).parent / "contract"
DB = json.loads(gzip.open(HERE / "db.json.gz").read())
ROUTES: list[dict[str, Any]] = json.loads(gzip.open(HERE / "routes.json.gz").read())


@pytest.fixture(scope="session")
def contract_url(pg_uri: str, template_uri: str) -> str:
    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute("CREATE DATABASE contract TEMPLATE payops_template")
    url = _with_database(pg_uri, "contract")
    with psycopg.connect(url, autocommit=True) as conn:
        # The dump is consistent, but tables load in alphabetical order, so foreign keys are not checked while it loads.
        conn.execute("SET session_replication_role = replica")
        for table, rows in DB["tables"].items():
            for row in rows:
                conn.execute(f'INSERT INTO "{table}" SELECT * FROM jsonb_populate_record(NULL::"{table}", %s)', [Jsonb(row)])
    return url


@pytest_asyncio.fixture(scope="session")
async def client(contract_url: str) -> AsyncIterator[httpx.AsyncClient]:
    engine = create_engine(url=contract_url, pool_size=5)
    app = create_app(Settings(), engine, clock=FixedClock(datetime.fromisoformat(DB["now"])))
    user = SessionUser.model_validate(DB["user"])

    @app.middleware("http")
    async def signed_in(request, call_next):  # type: ignore[no-untyped-def]
        request.state.user = user
        return await call_next(request)

    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c
    await engine.dispose()


def _same(expected: Any, actual: Any, path: str = "$") -> str | None:
    """The first difference between two JSON values, as a path and a short description, or None when they are equal."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in actual:
                return f"{path}.{key}: missing in Python (TypeScript sent {str(expected[key])[:80]!r})"
            if key not in expected:
                return f"{path}.{key}: extra in Python ({str(actual[key])[:80]!r})"
            if (diff := _same(expected[key], actual[key], f"{path}.{key}")) is not None:
                return diff
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{path}: {len(expected)} items in TypeScript, {len(actual)} in Python"
        for i, (e, a) in enumerate(zip(expected, actual, strict=True)):
            if (diff := _same(e, a, f"{path}[{i}]")) is not None:
                return diff
        return None
    if expected != actual or type(expected) is not type(actual) and not (isinstance(expected, (int, float)) and isinstance(actual, (int, float))):
        return f"{path}: TypeScript {expected!r}, Python {actual!r}"
    return None


@pytest.mark.parametrize("route", ROUTES, ids=[r["name"] for r in ROUTES])
async def test_route_matches_the_typescript_response(client: httpx.AsyncClient, route: dict[str, Any]) -> None:
    res = await client.get(route["path"])
    if res.status_code == 404 and "No route for" in res.text:
        pytest.skip("not ported yet")
    assert res.status_code == route["status"], res.text[:300]
    if route["contentType"] == "application/json":
        diff = _same(route["body"], res.json())
        assert diff is None, f"{route['path']}\n{diff}"
    elif route["name"] == "audit export":
        # The export audits itself, and that last row has a random id (and so a different hash) on every run: compare everything else.
        expected, actual = route["body"].split("\r\n"), res.text.split("\r\n")
        assert actual[:-2] == expected[:-2]
        mine, theirs = actual[-2].split(","), expected[-2].split(",")
        assert [c for i, c in enumerate(mine) if i not in (1, 15)] == [c for i, c in enumerate(theirs) if i not in (1, 15)]
    else:
        assert res.text == route["body"]
