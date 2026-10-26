# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false, reportAttributeAccessIssue=false
"""The agent graph running inside the API, end to end in REPLAY mode: start a run over HTTP, let the job run it, and compare what it concluded with what the
TypeScript graph concluded on the same recorded scenarios (the three runs in the contract dump). Then a person decides the approval and the run resumes."""

from __future__ import annotations

import gzip
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import select, text

from payops.api.app import create_app
from payops.api.security import SessionUser
from payops.db.engine import create_engine
from payops.db.models import AgentFinding, AgentStep, Case, Evidence
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_simulator_parity import NOW

RECORDED = json.loads(gzip.open(Path(__file__).parent / "contract" / "db.json.gz").read())["tables"]
JSON = {"content-type": "application/json"}
OPS = SessionUser(id="usr_ops", email="ops@payops.dev", name="Ops", role="OPS")
MANAGER = SessionUser(id="usr_mgr", email="manager@payops.dev", name="Meera Iyer", role="MANAGER")
USERS = {"ops": OPS, "manager": MANAGER}


@pytest_asyncio.fixture
async def world(database_url: str) -> AsyncIterator[tuple[httpx.AsyncClient, Any, dict[str, str]]]:
    engine = create_engine(url=database_url, pool_size=8)
    app = create_app(Settings(node_env="test"), engine, clock=FixedClock(NOW))

    @app.middleware("http")
    async def signed_in(request, call_next):  # type: ignore[no-untyped-def]
        if who := request.headers.get("x-test-user"):
            request.state.user = USERS[who]
        return await call_next(request)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers=JSON) as c,
    ):
        await app.state.services.simulator.seed_demo_cases()
        async with app.state.services.sessions() as s:
            ids = {d: i for d, i in (await s.execute(select(Case.display_id, Case.id))).all()}
        yield c, app, ids
    await engine.dispose()


async def run_case(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]], display_id: str, scenario: str
) -> dict[str, Any]:
    c, app, ids = world
    res = await c.post(
        f"/api/cases/{ids[display_id]}/runs", json={"scenarioKey": scenario}, headers={"x-test-user": "ops"}
    )
    assert res.status_code == 202, res.text
    run_id = res.json()["runId"]
    await app.state.jobs.idle()
    run = (await c.get(f"/api/runs/{run_id}", headers={"x-test-user": "ops"})).json()
    assert run["error"] is None, run["error"]
    return run  # type: ignore[no-any-return]


def recorded(display_id: str) -> dict[str, Any]:
    case_id = next(x["id"] for x in RECORDED["cases"] if x["display_id"] == display_id)
    return next(r for r in RECORDED["agent_runs"] if r["case_id"] == case_id)


async def test_an_auto_fix_resolves_the_case_the_way_typescript_did(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]],
) -> None:
    c, app, ids = world
    run = await run_case(world, "PAY-0001", "captured_order_failed")
    expected = recorded("PAY-0001")
    assert run["status"] == expected["status"] == "RESOLVED"
    assert run["path"] == expected["path"]
    assert run["diagnosis"]["rootCause"] == expected["diagnosis"]["rootCause"]
    assert run["policy"]["tier"] == "AUTO" and run["validation"]["verdict"] == "PASS"
    assert len(run["evidence"]) == len(expected["evidence"]) and len(run["findings"]) == len(expected["findings"])
    case = (await c.get(f"/api/cases/{ids['PAY-0001']}", headers={"x-test-user": "ops"})).json()
    assert case["status"] == "RESOLVED" and case["resolution"]["by"] == "AGENT"
    # every step was recorded in order, and the evidence and findings were copied into their own tables
    async with app.state.services.sessions() as s:
        seqs = [
            x
            for (x,) in (
                await s.execute(select(AgentStep.seq).where(AgentStep.run_id == run["id"]).order_by(AgentStep.seq))
            ).all()
        ]
        assert seqs == list(range(1, len(seqs) + 1)) and len(seqs) > 20
        assert len((await s.scalars(select(Evidence).where(Evidence.run_id == run["id"]))).all()) == len(
            run["evidence"]
        )
        assert len((await s.scalars(select(AgentFinding).where(AgentFinding.run_id == run["id"]))).all()) == len(
            run["findings"]
        )


async def test_a_manager_tier_fix_waits_for_approval_then_resumes_and_resolves(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]],
) -> None:
    c, app, ids = world
    run = await run_case(world, "RFD-0002", "refund_never_initiated")
    expected = recorded("RFD-0002")
    assert run["status"] == expected["status"] == "AWAITING_APPROVAL"
    assert run["diagnosis"]["rootCause"] == expected["diagnosis"]["rootCause"] and run["policy"]["tier"] == "MANAGER"
    assert run["approvalId"]
    approvals = (await c.get("/api/approvals", headers={"x-test-user": "manager"})).json()["items"]
    mine = next(a for a in approvals if a["id"] == run["approvalId"])
    assert mine["requestedBy"]["type"] == "AGENT" and mine["canDecide"] is True

    decided = await c.post(
        f"/api/approvals/{run['approvalId']}/decision",
        json={"decision": "APPROVE", "comment": "Refund is owed"},
        headers={"x-test-user": "manager"},
    )
    assert decided.status_code == 200
    await app.state.jobs.idle()
    after = (await c.get(f"/api/runs/{run['id']}", headers={"x-test-user": "ops"})).json()
    assert after["status"] == "RESOLVED" and after["validation"]["verdict"] == "PASS", after["error"]
    assert [s["status"] for s in after["executions"]] == ["SUCCEEDED"]


async def test_a_rejected_approval_ends_the_run_without_executing(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]],
) -> None:
    c, app, ids = world
    run = await run_case(world, "RFD-0002", "refund_never_initiated")
    res = await c.post(
        f"/api/approvals/{run['approvalId']}/decision",
        json={"decision": "REJECT", "comment": "Not this refund"},
        headers={"x-test-user": "manager"},
    )
    assert res.status_code == 200
    await app.state.jobs.idle()
    after = (await c.get(f"/api/runs/{run['id']}", headers={"x-test-user": "ops"})).json()
    assert after["status"] in ("ESCALATED", "REJECTED") and after["executions"] == []


async def test_the_settlement_case_pauses_for_an_ops_approval_like_typescript(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]],
) -> None:
    run = await run_case(world, "STL-0001", "settlement_mismatch")
    expected = recorded("STL-0001")
    assert run["status"] == expected["status"] and run["policy"]["tier"] == expected["policy"]["tier"] == "OPS"
    assert run["diagnosis"]["rootCause"] == expected["diagnosis"]["rootCause"]


async def test_starting_a_run_needs_ops_a_known_case_and_an_agent_that_is_not_paused(
    world: tuple[httpx.AsyncClient, Any, dict[str, str]],
) -> None:
    c, app, ids = world
    assert (await c.post(f"/api/cases/{ids['PAY-0001']}/runs", json={})).status_code == 401
    assert (await c.post("/api/cases/case_nope/runs", json={}, headers={"x-test-user": "ops"})).status_code == 404
    assert (
        await c.post(f"/api/cases/{ids['PAY-0001']}/runs", json={"scenarioKey": "nope"}, headers={"x-test-user": "ops"})
    ).status_code == 422
    paused = await c.put(
        "/api/agent-control", json={"mode": "PAUSED", "reason": "Gateway incident"}, headers={"x-test-user": "manager"}
    )
    assert paused.status_code == 200
    blocked = await c.post(f"/api/cases/{ids['PAY-0001']}/runs", json={}, headers={"x-test-user": "ops"})
    assert blocked.status_code == 409 and "paused" in blocked.json()["error"]["message"]
    async with app.state.services.sessions() as s:
        assert (await s.execute(text("select count(*) from agent_runs"))).scalar_one() == 0
