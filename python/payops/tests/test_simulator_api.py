# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The simulator routes over HTTP: generating scenarios, the one-per-seed rule, reset with and without the demo cases, undo, the cooldown and who may use it."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import func, select

from payops.api.app import create_app
from payops.api.security import SessionUser
from payops.db.engine import create_engine
from payops.db.models import AuditEvent, Case, User
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_simulator_parity import NOW

ADMIN = SessionUser(id="usr_admin", email="admin@payops.dev", name="Admin", role="ADMIN")
OPS = SessionUser(id="usr_ops", email="ops@payops.dev", name="Ops", role="OPS")
VIEWER = SessionUser(id="usr_view", email="v@payops.dev", name="Vik", role="VIEWER")
USERS = {"admin": ADMIN, "ops": OPS, "viewer": VIEWER}
JSON = {"content-type": "application/json"}


def make_client(url: str, settings: Settings) -> Any:
    engine = create_engine(url=url, pool_size=5)
    app = create_app(settings, engine, clock=FixedClock(NOW))

    @app.middleware("http")
    async def signed_in(request, call_next):  # type: ignore[no-untyped-def]
        if who := request.headers.get("x-test-user"):
            request.state.user = USERS[who]
        return await call_next(request)

    return engine, app


@pytest_asyncio.fixture
async def client(database_url: str) -> AsyncIterator[tuple[httpx.AsyncClient, Any]]:
    engine, app = make_client(database_url, Settings(node_env="test", demo_mode=True))
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers=JSON) as c:
        yield c, app
    await engine.dispose()


def as_(who: str) -> dict[str, str]:
    return {"x-test-user": who}


async def count(app: Any, model: type, *where: Any) -> int:
    async with app.state.services.sessions() as s:
        return (await s.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


async def test_the_scenario_list_has_every_scenario(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, _ = client
    items = (await c.get("/api/simulator/scenarios", headers=as_("ops"))).json()
    assert len(items) == 21 and items[0] == {"key": "healthy_payment", "title": "Healthy payment", "description": items[0]["description"], "expectedCaseType": None}
    assert (await c.get("/api/simulator/recorded", headers=as_("ops"))).json()  # the repository ships recorded model responses


async def test_generating_a_scenario_opens_the_expected_case_and_the_same_seed_twice_is_refused(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, app = client
    res = await c.post("/api/simulator/scenarios", json={"scenario": "captured_order_failed", "seed": 7}, headers=as_("ops"))
    assert res.status_code == 201
    body = res.json()
    assert body["seed"] == 7 and len(body["created"]["paymentIds"]) == 1 and [x["type"] for x in body["casesOpened"]] == ["PAYMENT_MISMATCH"]
    again = await c.post("/api/simulator/scenarios", json={"scenario": "captured_order_failed", "seed": 7}, headers=as_("ops"))
    assert again.status_code == 409
    other = await c.post("/api/simulator/scenarios", json={"scenario": "captured_order_failed", "seed": 8, "noise": 5}, headers=as_("ops"))
    assert other.status_code == 201 and len(other.json()["created"]["paymentIds"]) == 6
    assert await count(app, Case) == 2  # noise never opens a case
    assert await count(app, AuditEvent, AuditEvent.action == "simulator.generated") == 2


async def test_a_healthy_payment_opens_nothing(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, app = client
    res = await c.post("/api/simulator/scenarios", json={"scenario": "healthy_payment", "seed": 1}, headers=as_("ops"))
    assert res.status_code == 201 and res.json()["casesOpened"] == []
    assert await count(app, Case) == 0


async def test_a_bad_scenario_or_seed_is_422(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, _ = client
    assert (await c.post("/api/simulator/scenarios", json={"scenario": "nope"}, headers=as_("ops"))).status_code == 422
    assert (await c.post("/api/simulator/scenarios", json={"scenario": "healthy_payment", "seed": -1}, headers=as_("ops"))).status_code == 422
    assert (await c.post("/api/simulator/scenarios", json={"scenario": "healthy_payment", "noise": 51}, headers=as_("ops"))).status_code == 422


async def test_who_may_use_it(database_url: str) -> None:
    for demo, ops_status in ((True, 200), (False, 403)):
        engine, app = make_client(database_url, Settings(node_env="test", demo_mode=demo))
        async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers=JSON) as c:
            assert (await c.get("/api/simulator/scenarios")).status_code == 401
            assert (await c.get("/api/simulator/scenarios", headers=as_("viewer"))).status_code == 403
            assert (await c.get("/api/simulator/scenarios", headers=as_("ops"))).status_code == ops_status
            assert (await c.get("/api/simulator/scenarios", headers=as_("admin"))).status_code == 200
        await engine.dispose()


async def test_reset_wipes_the_demo_data_and_keeps_users_then_undo_brings_it_back(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, app = client
    await c.post("/api/simulator/scenarios", json={"scenario": "refund_never_initiated", "seed": 3}, headers=as_("ops"))
    users_before, cases_before = await count(app, User), await count(app, Case)
    assert cases_before == 1
    assert (await c.get("/api/simulator/reset-status", headers=as_("ops"))).json() == {"canUndo": False, "snapshotAt": None, "loadingDemo": False}

    res = await c.post("/api/simulator/reset", json={}, headers=as_("ops"))
    assert res.status_code == 200 and res.json()["canUndo"] is True and res.json()["loadingDemo"] is False
    assert res.json()["snapshotAt"] == NOW.isoformat().replace("+00:00", "Z").replace("Z", ".000Z") or res.json()["snapshotAt"].startswith("2026-09-28T12:00:00")
    assert await count(app, Case) == 0 and await count(app, User) == users_before
    audit = (await c.get("/api/audit", headers=as_("admin"))).json()["items"]
    assert [a["action"] for a in audit] == ["simulator.reset"]  # the audit log restarts with the demo data

    undone = await c.post("/api/simulator/undo-reset", headers=as_("ops"))
    assert undone.status_code == 200 and undone.json()["canUndo"] is False
    assert await count(app, Case) == cases_before
    assert (await c.post("/api/simulator/undo-reset", headers=as_("ops"))).status_code == 409  # nothing left to undo


async def test_reset_with_the_demo_loads_the_cases_in_the_background_and_blocks_another_reset_meanwhile(client: tuple[httpx.AsyncClient, Any]) -> None:
    c, app = client
    res = await c.post("/api/simulator/reset", json={"demo": True}, headers=as_("ops"))
    assert res.status_code == 200 and res.json()["loadingDemo"] is True
    assert (await c.post("/api/simulator/reset", json={}, headers=as_("ops"))).status_code == 429  # one at a time while the demo loads
    assert (await c.post("/api/simulator/undo-reset", headers=as_("ops"))).status_code == 429
    await app.state.services.simulator.wait_for_demo()
    assert (await c.get("/api/simulator/reset-status", headers=as_("ops"))).json()["loadingDemo"] is False
    assert await count(app, Case) == 20  # every fault scenario opens its case
    listed = (await c.get("/api/cases?scope=all&limit=100", headers=as_("ops"))).json()
    assert listed["total"] == 20


async def test_a_second_reset_inside_the_cooldown_is_refused_outside_tests(database_url: str) -> None:
    engine, app = make_client(database_url, Settings(node_env="development", demo_mode=True))
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers=JSON) as c:
        assert (await c.post("/api/simulator/reset", json={}, headers=as_("ops"))).status_code == 200
        second = await c.post("/api/simulator/reset", json={}, headers=as_("ops"))
        assert second.status_code == 429 and "Try again in" in second.json()["error"]["message"]
    await engine.dispose()


