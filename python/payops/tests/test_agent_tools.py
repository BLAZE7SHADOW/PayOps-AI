# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The agent tool layer against what the TypeScript code computed on the same data: for each of the 20 demo cases, the case brief, the output of every tool,
and the proposal for every root cause (tests/fixtures/agent_tools.json.gz, made by packages/evals/scripts/export-agent-tools.ts)."""

from __future__ import annotations

import gzip
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import select

from payops.agent_tools.brief import build_case_brief
from payops.agent_tools.proposal import build_proposal
from payops.agent_tools.tools import ALL_TOOLS, TOOLS_BY_NAME
from payops.container import Services, build_services
from payops.db.engine import create_engine, session_factory
from payops.db.models import Case
from payops.infra.snapshots import load_case_state
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_simulator_parity import NOW

FIX = json.loads(gzip.open(Path(__file__).parent / "fixtures" / "agent_tools.json.gz").read())


@pytest_asyncio.fixture(scope="module")
async def world(pg_uri: str, template_uri: str) -> AsyncIterator[tuple[Services, dict[str, str]]]:
    import psycopg

    from tests.conftest import _with_database

    with psycopg.connect(pg_uri, autocommit=True) as conn:
        conn.execute("CREATE DATABASE agent_tools TEMPLATE payops_template")
    engine = create_engine(url=_with_database(pg_uri, "agent_tools"), pool_size=3)
    services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
    await services.simulator.seed_demo_cases()
    async with services.sessions() as s:
        ids = {display: case_id for display, case_id in (await s.execute(select(Case.display_id, Case.id))).all()}
    yield services, ids
    await engine.dispose()


async def state_of(world: tuple[Services, dict[str, str]], display_id: str) -> Any:
    services, ids = world
    async with services.sessions() as s:
        return await load_case_state(s, services.gateway, ids[display_id], NOW)


def test_the_tool_names_are_the_ones_typescript_has() -> None:
    expected = {t["tool"] for t in next(iter(FIX["cases"].values()))["tools"]}
    assert {t.name for t in ALL_TOOLS} == expected and len(ALL_TOOLS) == 15


@pytest.mark.parametrize("display_id", sorted(FIX["cases"]))
async def test_the_brief_and_every_tool_match_typescript(
    world: tuple[Services, dict[str, str]], display_id: str
) -> None:
    expected = FIX["cases"][display_id]
    state = await state_of(world, display_id)
    # Case ids are random in both implementations, so the brief is compared with the id taken from this run.
    assert {"brief": build_case_brief(state), "entityRefs": state.case.entity_refs} == {
        "brief": {**expected["brief"]["brief"], "caseId": state.case.id},
        "entityRefs": expected["brief"]["entityRefs"],
    }
    for tool in expected["tools"]:
        mine = TOOLS_BY_NAME[tool["tool"]].run(state)
        if tool["tool"] == "getFeeBreakdown":
            # The settlement's `updated_at` is the real time in the TypeScript fixture (see test_simulator_parity); Python stamps the clock.
            for m, t in zip(mine, tool["drafts"], strict=True):
                t["observedAt"] = m["observedAt"]
        assert mine == tool["drafts"], f"{display_id} {tool['tool']}"


@pytest.mark.parametrize("display_id", sorted(FIX["cases"]))
async def test_the_proposal_for_every_root_cause_matches_typescript(
    world: tuple[Services, dict[str, str]], display_id: str
) -> None:
    state = await state_of(world, display_id)
    for root_cause, proposal in FIX["cases"][display_id]["proposals"].items():
        diagnosis = {
            "rootCause": root_cause,
            "narrative": f"Narrative for {root_cause}.",
            "confidence": 0.9,
            "supportingFindingIds": [],
            "path": "FAST",
        }
        assert build_proposal(diagnosis, state) == proposal, f"{display_id} {root_cause}"
