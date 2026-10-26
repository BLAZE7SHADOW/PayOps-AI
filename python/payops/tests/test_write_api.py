# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The write routes over HTTP: status codes, the error shape, permissions, and what each call leaves behind. The signed-in user is set per request by a
header so one app serves every role; real sessions arrive with the auth port."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest_asyncio

from payops.api.app import create_app
from payops.api.security import SessionUser
from payops.db.engine import create_engine
from payops.ports import FixedClock
from payops.settings import Settings
from tests.test_execution import NOW

USERS = {
    "ops": SessionUser(id="usr_81cv7z92n81hk7", email="ops@payops.dev", name="Ops One", role="OPS"),
    "ops2": SessionUser(id="usr_m3e4bbsmtc0d9m", email="ops2@payops.dev", name="Ops Two", role="OPS"),
    "manager": SessionUser(id="usr_3t6ty5cke43ngr", email="manager@payops.dev", name="Meera Iyer", role="MANAGER"),
    "viewer": SessionUser(id="usr_a9sywazwec7y15", email="viewer@payops.dev", name="Viewer", role="VIEWER"),
}
PAY_0004 = "case_w3wryfpvbpyt13"


@pytest_asyncio.fixture
async def client(seeded_url: str) -> AsyncIterator[httpx.AsyncClient]:
    engine = create_engine(url=seeded_url, pool_size=5)
    app = create_app(Settings(), engine, clock=FixedClock(NOW))

    @app.middleware("http")
    async def signed_in(request, call_next):  # type: ignore[no-untyped-def]
        who = request.headers.get("x-test-user")
        if who:
            request.state.user = USERS[who]
        return await call_next(request)

    async with app.router.lifespan_context(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t", headers={"content-type": "application/json"}
    ) as c:
        yield c
    await engine.dispose()


def as_(who: str) -> dict[str, str]:
    return {"x-test-user": who}


async def test_nobody_signed_in_is_401_and_the_wrong_role_is_403(client: httpx.AsyncClient) -> None:
    assert (await client.post(f"/api/cases/{PAY_0004}/notes", json={"text": "hi"})).status_code == 401
    forbidden = await client.post(f"/api/cases/{PAY_0004}/notes", json={"text": "hi"}, headers=as_("viewer"))
    assert forbidden.status_code == 403 and forbidden.json()["error"]["code"] == "FORBIDDEN"


async def test_a_note_is_added_audited_and_listed_newest_first(client: httpx.AsyncClient) -> None:
    res = await client.post(f"/api/cases/{PAY_0004}/notes", json={"text": "  Bank confirmed the capture.  "}, headers=as_("ops"))
    assert res.status_code == 201
    note = res.json()
    assert note["text"] == "Bank confirmed the capture." and note["authorName"] == "Ops One" and note["caseId"] == PAY_0004
    notes = (await client.get(f"/api/cases/{PAY_0004}/notes", headers=as_("viewer"))).json()["items"]
    assert notes[0]["id"] == note["id"]
    audit = (await client.get(f"/api/audit?caseId={PAY_0004}", headers=as_("manager"))).json()["items"]
    assert any(a["action"] == "case.note_added" for a in audit)


async def test_an_empty_note_and_an_unknown_field_are_422_and_a_bad_id_is_400(client: httpx.AsyncClient) -> None:
    empty = await client.post(f"/api/cases/{PAY_0004}/notes", json={"text": "   "}, headers=as_("ops"))
    assert empty.status_code == 422 and empty.json()["error"]["code"] == "VALIDATION_FAILED"
    extra = await client.post(f"/api/cases/{PAY_0004}/notes", json={"text": "x", "author": "me"}, headers=as_("ops"))
    assert extra.status_code == 422
    assert (await client.post("/api/cases/not%20an%20id/notes", json={"text": "x"}, headers=as_("ops"))).status_code == 400
    assert (await client.post("/api/cases/case_nope/notes", json={"text": "x"}, headers=as_("ops"))).status_code == 404


async def test_saved_views_are_private_unique_and_deletable_only_by_the_owner(client: httpx.AsyncClient) -> None:
    body = {"name": "Mine", "filters": {"assigneeId": "me", "scope": "open"}}
    created = await client.post("/api/views", json=body, headers=as_("ops"))
    assert created.status_code == 201 and created.json()["filters"] == {"assigneeId": "me", "scope": "open"}
    dup = await client.post("/api/views", json=body, headers=as_("ops"))
    assert dup.status_code == 409
    assert (await client.get("/api/views", headers=as_("ops2"))).json()["items"] == []
    view_id = created.json()["id"]
    assert (await client.delete(f"/api/views/{view_id}", headers=as_("ops2"))).status_code == 404
    assert (await client.delete(f"/api/views/{view_id}", headers=as_("ops"))).status_code == 204
    assert (await client.get("/api/views", headers=as_("ops"))).json()["items"] == []


async def test_the_agent_switch_needs_a_manager_and_a_reason(client: httpx.AsyncClient) -> None:
    assert (await client.put("/api/agent-control", json={"mode": "PAUSED", "reason": "Gateway incident"}, headers=as_("ops"))).status_code == 403
    assert (await client.put("/api/agent-control", json={"mode": "PAUSED"}, headers=as_("manager"))).status_code == 422
    ok = await client.put("/api/agent-control", json={"mode": "PAUSED", "reason": "Gateway incident"}, headers=as_("manager"))
    assert ok.status_code == 200 and ok.json()["mode"] == "PAUSED" and ok.json()["changedByName"] == "Meera Iyer"
    back = await client.put("/api/agent-control", json={"mode": "NORMAL", "reason": "stale reason"}, headers=as_("manager"))
    assert back.json()["mode"] == "NORMAL" and back.json()["reason"] == ""
    assert (await client.get("/api/agent-control", headers=as_("viewer"))).json()["mode"] == "NORMAL"


async def test_assigning_a_case_audits_once_and_refuses_a_viewer_as_assignee(client: httpx.AsyncClient) -> None:
    res = await client.put(f"/api/cases/{PAY_0004}/assignee", json={"assigneeId": USERS["ops2"].id}, headers=as_("ops"))
    assert res.status_code == 200 and res.json()["assignee"]["id"] == USERS["ops2"].id
    again = await client.put(f"/api/cases/{PAY_0004}/assignee", json={"assigneeId": USERS["ops2"].id}, headers=as_("ops"))
    assert again.status_code == 200
    audit = (await client.get(f"/api/audit?caseId={PAY_0004}", headers=as_("manager"))).json()["items"]
    assert [a["action"] for a in audit].count("case.assigned") == 1
    bad = await client.put(f"/api/cases/{PAY_0004}/assignee", json={"assigneeId": USERS["viewer"].id}, headers=as_("ops"))
    assert bad.status_code == 422
    cleared = await client.put(f"/api/cases/{PAY_0004}/assignee", json={"assigneeId": None}, headers=as_("ops"))
    assert cleared.json()["assignee"] is None


async def test_feedback_on_a_diagnosis_is_recorded_and_replaced(client: httpx.AsyncClient) -> None:
    run = "run_vmtjp8b3x9mqwg"
    wrong_without_reason = await client.put(f"/api/runs/{run}/feedback", json={"verdict": "WRONG"}, headers=as_("ops"))
    assert wrong_without_reason.status_code == 422
    first = await client.put(f"/api/runs/{run}/feedback", json={"verdict": "RIGHT", "correctRootCause": "UNKNOWN"}, headers=as_("ops"))
    assert first.status_code == 200 and first.json()["verdict"] == "RIGHT" and first.json()["correctRootCause"] is None
    second = await client.put(f"/api/runs/{run}/feedback", json={"verdict": "WRONG", "reason": "It was the ledger", "correctRootCause": "LEDGER_POSTING_MISSING"}, headers=as_("ops"))
    assert second.json()["id"] == first.json()["id"] and second.json()["correctRootCause"] == "LEDGER_POSTING_MISSING"
    assert len((await client.get(f"/api/runs/{run}/feedback", headers=as_("viewer"))).json()["items"]) == 1
    assert (await client.put("/api/runs/run_nope/feedback", json={"verdict": "RIGHT"}, headers=as_("ops"))).status_code == 404


async def test_proposing_over_http_previews_then_resolves(client: httpx.AsyncClient) -> None:
    detail = (await client.get(f"/api/cases/{PAY_0004}", headers=as_("ops"))).json()
    options = {o["type"]: o for o in detail["resolutionView"]["actionOptions"]}
    actions = [options["MARK_ORDER_PAID"]["action"], options["POST_LEDGER_ENTRY"]["action"]]
    assert (await client.post(f"/api/cases/{PAY_0004}/actions/preview", json={"actions": actions}, headers=as_("viewer"))).status_code == 403
    preview = await client.post(f"/api/cases/{PAY_0004}/actions/preview", json={"actions": actions}, headers=as_("ops"))
    assert preview.status_code == 200 and preview.json()["decision"]["tier"] == "AUTO" and preview.json()["attempt"] == 1
    short = await client.post(f"/api/cases/{PAY_0004}/actions", json={"actions": actions, "rationale": "too short"}, headers=as_("ops"))
    assert short.status_code == 422
    done = await client.post(f"/api/cases/{PAY_0004}/actions", json={"actions": actions, "rationale": "Capture verified at the gateway."}, headers=as_("ops"))
    assert done.status_code == 201 and done.json()["status"] == "VALIDATED" and done.json()["validation"]["verdict"] == "PASS"
    after = (await client.get(f"/api/cases/{PAY_0004}", headers=as_("ops"))).json()
    assert after["status"] == "RESOLVED" and after["resolution"]["by"] == "USER"


async def test_a_refund_waits_for_a_manager_and_the_decision_route_enforces_it(client: httpx.AsyncClient) -> None:
    case_id = "case_ryxqgc2hh458n7"
    detail = (await client.get(f"/api/cases/{case_id}", headers=as_("ops"))).json()
    refund = next(o for o in detail["resolutionView"]["actionOptions"] if o["type"] == "INITIATE_REFUND")["action"]
    proposed = await client.post(f"/api/cases/{case_id}/actions", json={"actions": [refund], "rationale": "Refund is missing at the gateway."}, headers=as_("ops"))
    assert proposed.status_code == 201 and proposed.json()["status"] == "AWAITING_APPROVAL"
    approval_id = proposed.json()["approval"]["id"]
    pending = (await client.get("/api/approvals", headers=as_("manager"))).json()["items"]
    assert any(a["id"] == approval_id and a["canDecide"] for a in pending)
    assert (await client.post(f"/api/approvals/{approval_id}/decision", json={"decision": "APPROVE"}, headers=as_("ops2"))).status_code == 403
    assert (await client.post(f"/api/approvals/{approval_id}/decision", json={"decision": "REJECT", "comment": "no"}, headers=as_("manager"))).status_code == 422
    ok = await client.post(f"/api/approvals/{approval_id}/decision", json={"decision": "APPROVE", "comment": "Verified"}, headers=as_("manager"))
    assert ok.status_code == 200 and ok.json()["status"] == "APPROVED"
    again = await client.post(f"/api/approvals/{approval_id}/decision", json={"decision": "APPROVE"}, headers=as_("manager"))
    assert again.status_code == 409


async def test_replaying_a_webhook_from_the_log_needs_ops_and_is_audited(client: httpx.AsyncClient) -> None:
    event = (await client.get("/api/webhooks?status=FAILED", headers=as_("viewer"))).json()["items"]
    event_id = event[0]["id"] if event else (await client.get("/api/webhooks", headers=as_("viewer"))).json()["items"][0]["id"]
    assert (await client.post(f"/api/webhooks/{event_id}/replay", headers=as_("viewer"))).status_code == 403
    res = await client.post(f"/api/webhooks/{event_id}/replay", headers=as_("ops"))
    assert res.status_code == 200 and res.json()["attemptCount"] >= 2 and res.json()["attempts"][-1]["source"] == "MANUAL"
    audit = (await client.get(f"/api/audit?entityId={event_id}", headers=as_("manager"))).json()["items"]
    assert any(a["action"] == "webhook.replayed" for a in audit)
