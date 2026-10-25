from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from payops_agents.app import create_app
from payops_agents.run import AgentRunner
from payops_agents.settings import Settings
from tests.fakes import FakeNodeApi

SECRET = "test-agent-secret-0123456789"


@pytest.fixture
def client() -> Iterator[TestClient]:
    api = FakeNodeApi()
    app = create_app(AgentRunner(api, InMemorySaver()), Settings(agent_internal_secret=SECRET))  # type: ignore[arg-type]
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


def test_fixtures_are_refused_unless_enabled(client: TestClient) -> None:
    body = start_body(client.api, fixture={"rootCause": "DUPLICATE_CAPTURE"})  # type: ignore[attr-defined]
    assert client.post("/runs", json=body, headers={"x-agent-secret": SECRET}).status_code == 400
    enabled = create_app(AgentRunner(client.api, InMemorySaver()), Settings(agent_internal_secret=SECRET, agent_allow_fixtures=True))  # type: ignore[attr-defined,arg-type]
    with TestClient(enabled) as c:
        assert c.post("/runs", json=body, headers={"x-agent-secret": SECRET}).status_code == 200


def test_a_bad_body_is_a_422(client: TestClient) -> None:
    assert client.post("/runs", json={"runId": "r"}, headers={"x-agent-secret": SECRET}).status_code == 422


def test_ready_reports_the_checkpoint_store_and_every_response_carries_a_request_id(client: TestClient) -> None:
    ready = client.get("/ready")
    assert ready.status_code == 200 and ready.json()["status"] == "ready"
    assert len(ready.headers["x-request-id"]) >= 8
    echoed = client.get("/health", headers={"x-request-id": "abc-12345678"})
    assert echoed.headers["x-request-id"] == "abc-12345678"


def test_a_repeated_start_reports_the_finished_run_without_running_it_again(client: TestClient) -> None:
    headers = {"x-agent-secret": SECRET}
    first = client.post("/runs", json=start_body(client.api), headers=headers).json()  # type: ignore[attr-defined]
    calls_after_first = list(client.api.calls)  # type: ignore[attr-defined]
    second = client.post("/runs", json=start_body(client.api), headers=headers)  # type: ignore[attr-defined]
    assert second.status_code == 200 and second.json()["status"] == first["status"] == "RESOLVED"
    assert client.api.calls == calls_after_first  # type: ignore[attr-defined]
    assert len(client.api.synced) == 1  # type: ignore[attr-defined]


def test_resuming_a_run_that_never_started_is_a_409(client: TestClient) -> None:
    body = {"caseId": "case_x", "aiMode": "REPLAY", "decision": {"decision": "APPROVE"}}
    assert client.post("/runs/run_never/resume", json=body, headers={"x-agent-secret": SECRET}).status_code == 409
