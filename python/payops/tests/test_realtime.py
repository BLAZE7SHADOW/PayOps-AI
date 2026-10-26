# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false, reportAttributeAccessIssue=false
"""Realtime with the real Socket.IO client against a real server: only signed-in users connect, events reach the ops room, case rooms are joined on demand,
and a revoked session loses its socket."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest_asyncio
import socketio
import uvicorn
from sqlalchemy import update

from payops.api.app import create_app
from payops.auth.demo_users import DEMO_PASSWORD
from payops.auth.password import hash_password
from payops.db.engine import create_engine
from payops.db.models import User
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_execution import NOW

JSON = {"content-type": "application/json"}


class Live:
    def __init__(self, url: str, app: Any) -> None:
        self.url = url
        self.app = app

    async def sign_in(self, email: str = "ops@payops.dev") -> str:
        async with httpx.AsyncClient(base_url=self.url, headers=JSON) as c:
            res = await c.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
            assert res.status_code == 200
            return f"payops_session={res.cookies['payops_session']}"


@pytest_asyncio.fixture
async def live(seeded_url: str) -> AsyncIterator[Live]:
    engine = create_engine(url=seeded_url, pool_size=5)
    app = create_app(Settings(jwt_secret="a-test-secret-of-sufficient-length"), engine, clock=FixedClock(NOW))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on"))
    task = asyncio.get_running_loop().create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    async with engine.begin() as conn:
        await conn.execute(update(User).values(password_hash=hash_password(DEMO_PASSWORD)))
    try:
        yield Live(f"http://127.0.0.1:{port}", app)
    finally:
        server.should_exit = True
        await task
        await engine.dispose()


async def connect(live: Live, cookie: str | None) -> tuple[socketio.AsyncClient, list[tuple[str, Any]]]:
    client = socketio.AsyncClient()
    received: list[tuple[str, Any]] = []
    for name in ("case.created", "case.updated", "resolution.updated"):
        client.on(name, lambda payload, name=name: received.append((name, payload)))
    await client.connect(live.url, headers={"Cookie": cookie} if cookie else {}, socketio_path="/socket.io", transports=["websocket"], wait_timeout=5)
    return client, received


async def until(condition: Any, seconds: float = 5) -> None:
    for _ in range(int(seconds / 0.05)):
        if condition():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("timed out waiting for the event")


async def test_a_visitor_without_a_session_cannot_connect(live: Live) -> None:
    refused = False
    try:
        await connect(live, None)
    except socketio.exceptions.ConnectionError:
        refused = True
    assert refused


async def test_a_signed_in_user_receives_events_for_the_ops_room(live: Live) -> None:
    cookie = await live.sign_in()
    client, received = await connect(live, cookie)
    try:
        async with httpx.AsyncClient(base_url=live.url, headers={**JSON, "Cookie": cookie}) as c:
            res = await c.post("/api/simulator/scenarios", json={"scenario": "late_webhook_retrying", "seed": 9})
            assert res.status_code == 201
        await until(lambda: any(name == "case.created" for name, _ in received))
        payload = next(p for name, p in received if name == "case.created")
        assert payload["type"] == "PAYMENT_MISMATCH" and payload["displayId"].startswith("PAY-")
    finally:
        await client.disconnect()


async def test_case_rooms_are_joined_on_demand(live: Live) -> None:
    cookie = await live.sign_in()
    client, _ = await connect(live, cookie)
    try:
        await client.emit("case:join", "case_x")
        await asyncio.sleep(0.2)
        sio = live.app.state.realtime.sio
        rooms = {r for sid in list(sio.manager.rooms.get("/", {}).keys()) for r in [sid]}
        assert "case:case_x" in rooms and "ops" in rooms
        await client.emit("case:leave", "case_x")
        await asyncio.sleep(0.2)
        assert "case:case_x" not in sio.manager.rooms.get("/", {})
    finally:
        await client.disconnect()


async def test_a_revoked_session_loses_its_socket(live: Live) -> None:
    cookie = await live.sign_in()
    client, _ = await connect(live, cookie)
    assert client.connected
    async with httpx.AsyncClient(base_url=live.url, headers={**JSON, "Cookie": cookie}) as c:
        assert (await c.post("/api/auth/logout")).status_code == 200
    await until(lambda: not client.connected)
