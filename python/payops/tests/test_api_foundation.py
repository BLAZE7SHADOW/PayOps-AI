from collections.abc import AsyncIterator

import httpx
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.api.app import create_app
from payops.errors import AppError
from payops.settings import Settings


@pytest_asyncio.fixture
async def client(engine: AsyncEngine) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(Settings(), engine)

    @app.get("/api/_boom")
    async def boom() -> None:
        raise RuntimeError("secret detail")

    @app.get("/api/_conflict")
    async def conflict() -> None:
        raise AppError("INVALID_TRANSITION", "Cannot go from OPEN to OPEN", {"from": "OPEN"})

    @app.post("/api/_echo")
    async def echo(body: dict[str, int]) -> dict[str, int]:
        return body

    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        yield c


async def test_health_checks_the_database(client: httpx.AsyncClient) -> None:
    res = await client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "checks": {"database": "ok"}, "aiMode": "REPLAY"}
    assert len(res.headers["x-request-id"]) >= 8


async def test_unknown_routes_use_the_shared_error_shape(client: httpx.AsyncClient) -> None:
    res = await client.get("/api/nope", headers={"x-request-id": "req-abcdef123"})
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "No route for GET /api/nope", "requestId": "req-abcdef123"}}


async def test_app_errors_carry_their_status_and_details(client: httpx.AsyncClient) -> None:
    res = await client.get("/api/_conflict")
    assert res.status_code == 409
    error = res.json()["error"]
    assert error["code"] == "INVALID_TRANSITION" and error["details"] == {"from": "OPEN"}


async def test_bad_json_is_400_and_wrong_json_is_422(client: httpx.AsyncClient) -> None:
    bad = await client.post("/api/_echo", content="{not json", headers={"content-type": "application/json"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "BAD_REQUEST"
    wrong = await client.post("/api/_echo", json={"a": "text"})
    assert wrong.status_code == 422
    body = wrong.json()["error"]
    assert body["code"] == "VALIDATION_FAILED" and body["details"][0]["path"] == "a"


async def test_unexpected_errors_do_not_leak_details(client: httpx.AsyncClient) -> None:
    res = await client.get("/api/_boom")
    assert res.status_code == 500
    assert res.json()["error"]["message"] == "Unexpected server error"
    assert "secret detail" not in res.text
