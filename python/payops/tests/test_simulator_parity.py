# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The Python simulator must write exactly what the TypeScript simulator wrote: the same ids (seeded generators), the same rows, the same detection results.
tests/fixtures/simulator_seed.json.gz holds every table after `seedWorld` and `seedDemoCases` ran in TypeScript on an empty database with a fixed clock."""

from __future__ import annotations

import gzip
import json
import re
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text

from payops.container import Services, build_services
from payops.db.engine import create_engine, session_factory
from payops.ports import FixedClock
from payops.settings import Settings

SEED = json.loads(gzip.open(Path(__file__).parent / "fixtures" / "simulator_seed.json.gz").read())
NOW = datetime.fromisoformat(SEED["now"])
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")

#: Compared row for row, keyed by id. Cases have random ids (the TypeScript API generated them with `newId`), so they are compared by display id below.
EXACT_TABLES = (
    "merchants", "customers", "devices", "orders", "payments", "payment_attempts", "gw_payments", "gw_refunds", "gw_webhook_deliveries", "gw_settlement_lines",
    "ledger_entries", "refunds", "settlements", "support_notes", "webhook_events", "counters",
)  # fmt: skip


def normal(value: Any) -> Any:
    """Timestamps compare as instants (the text differs: `.000Z` against `+00:00`); everything else compares as it is."""
    if isinstance(value, str) and ISO.match(value) and "T" in value:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    if isinstance(value, dict):
        return {k: normal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normal(v) for v in value]
    return value


@pytest_asyncio.fixture
async def seeded(database_url: str) -> AsyncIterator[tuple[Services, Any]]:
    engine = create_engine(url=database_url, pool_size=5)
    services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
    await services.simulator.seed_demo_cases()
    yield services, engine
    await engine.dispose()


def drop_wall_clock(table: str, row: dict[str, Any]) -> dict[str, Any]:
    """The TypeScript API stamped `updated_at` with the real time (not the clock) whenever detection updated a settlement or screening tagged a case, so those
    two columns hold the day the fixture was made. Python stamps the clock's time, which is the same instant in every run."""
    return {k: v for k, v in row.items() if not (k == "updated_at" and table in ("settlements", "cases"))}


async def rows(services: Services, table: str) -> list[dict[str, Any]]:
    async with services.sessions() as s:
        return [r[0] for r in (await s.execute(text(f'select to_jsonb(x) from "{table}" x'))).all()]


@pytest.mark.parametrize("table", EXACT_TABLES)
async def test_table_matches_the_typescript_simulator(seeded: tuple[Services, Any], table: str) -> None:
    services, _ = seeded
    mine = {r.get("id", r.get("key")): normal(drop_wall_clock(table, r)) for r in await rows(services, table)}
    theirs = {r.get("id", r.get("key")): normal(drop_wall_clock(table, r)) for r in SEED["tables"][table]}
    assert sorted(mine) == sorted(theirs), f"{table}: ids differ"
    for key, expected in theirs.items():
        assert mine[key] == expected, f"{table} {key}:\n  python {mine[key]}\n  ts     {expected}"


async def test_detection_opened_the_same_cases(seeded: tuple[Services, Any]) -> None:
    services, _ = seeded
    mine = {r["display_id"]: normal(drop_wall_clock("cases", r)) for r in await rows(services, "cases")}
    theirs = {r["display_id"]: normal(drop_wall_clock("cases", r)) for r in SEED["tables"]["cases"]}
    assert sorted(mine) == sorted(theirs)
    for display_id, expected in theirs.items():
        # Case ids are random in both implementations; everything else is deterministic. Only compare the ids' presence.
        a, b = (
            {k: v for k, v in mine[display_id].items() if k != "id"},
            {k: v for k, v in expected.items() if k != "id"},
        )
        assert a == b, f"{display_id}:\n  python {a}\n  ts     {b}"
