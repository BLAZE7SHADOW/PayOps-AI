from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from payops_agents.app import create_app
from payops_agents.run import AgentRunner
from tests.fakes import FakeNodeApi

SECRET = "test-agent-secret-0123456789"


@pytest.fixture
def client() -> Iterator[TestClient]:
    api = FakeNodeApi()
    app = create_app(AgentRunner(api, InMemorySaver()), SECRET)  # type: ignore[arg-type]
    with TestClient(app) as c:
        c.api = api  # type: ignore[attr-defined]
        yield c


def start_body(api: FakeNodeApi, **extra: object) -> dict:
    return {"runId": "run_1", "caseId": api.data["caseId"], "scenarioKey": "captured_order_failed", "aiMode": "REPLAY", **extra}


def test_health_is_open_and_runs_need_the_secret(client: TestClient) -> None:
    assert client.get("/health").json()["status"] == "ok"
    assert client.post("/runs", json=start_body(client.api)).status_code == 401  # type: ignore[attr-defined]
    assert client.post("/runs", json=start_body(client.api), headers={"x-agent-secret": "nope"}).status_code == 401  # type: ignore[attr-defined]


def test_a_run_answers_with_its_final_status_and_state(client: TestClient) -> None:
    res = client.post("/runs", json=start_body(client.api), headers={"x-agent-secret": SECRET})  # type: ignore[attr-defined]
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "RESOLVED" and body["interrupted"] is False
    assert body["state"]["diagnosis"]["rootCause"] == "WEBHOOK_PROCESSING_FAILURE"
    assert body["replay"]["jev"]["fallback"] == 0


def test_fixtures_are_refused_unless_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    body = start_body(client.api, fixture={"rootCause": "DUPLICATE_CAPTURE"})  # type: ignore[attr-defined]
    monkeypatch.delenv("AGENT_ALLOW_FIXTURES", raising=False)
    assert client.post("/runs", json=body, headers={"x-agent-secret": SECRET}).status_code == 400
    monkeypatch.setenv("AGENT_ALLOW_FIXTURES", "1")
    assert client.post("/runs", json=body, headers={"x-agent-secret": SECRET}).status_code == 200


def test_a_bad_body_is_a_422(client: TestClient) -> None:
    assert client.post("/runs", json={"runId": "r"}, headers={"x-agent-secret": SECRET}).status_code == 422
