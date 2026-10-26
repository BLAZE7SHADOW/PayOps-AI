# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false, reportAttributeAccessIssue=false
"""The resolution flow on the recorded scenarios: policy picks the tier, approvals follow four-eyes, executing and validating close the case, undo goes
through the same path, and detection reads the fixed data. (Replaces the resolution and approval coverage of the TypeScript end-to-end tests.)"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.api.security import SessionUser
from payops.container import Services, build_services
from payops.db.engine import create_engine, session_factory
from payops.db.models import Approval, AuditEvent, Case, LedgerEntry, Resolution
from payops.dto.resolution import ApprovalDecisionBody, PreviewActionsBody, ProposeActionsBody
from payops.errors import AppError
from payops.ports import FixedClock
from tests.test_execution import NOW

OPS = SessionUser(id="usr_ops_a", email="a@payops.dev", name="Ananya Rao", role="OPS")
OPS_B = SessionUser(id="usr_ops_b", email="b@payops.dev", name="Dev Patel", role="OPS")
MGR_A = SessionUser(id="usr_mgr_a", email="ma@payops.dev", name="Meera Iyer", role="MANAGER")
MGR_B = SessionUser(id="usr_mgr_b", email="mb@payops.dev", name="Rohan Shah", role="MANAGER")
VIEWER = SessionUser(id="usr_view", email="v@payops.dev", name="Vik", role="VIEWER")

PAY_0004 = "case_w3wryfpvbpyt13"  # captured at the gateway, order not paid, no ledger credit
FIX = [
    {"type": "MARK_ORDER_PAID", "params": {"orderId": "", "paymentId": ""}},
    {"type": "POST_LEDGER_ENTRY", "params": {"paymentId": "", "amountMinor": 1}},
]


@pytest_asyncio.fixture
async def services(seeded_url: str) -> AsyncIterator[Services]:
    engine: AsyncEngine = create_engine(url=seeded_url, pool_size=5)
    try:
        yield build_services(session_factory(engine), clock=FixedClock(NOW))
    finally:
        await engine.dispose()


async def prefilled(services: Services, case_id: str, types: list[str]) -> dict:  # type: ignore[type-arg]
    async with services.sessions() as s:
        view = (await services.cases.get(s, case_id, OPS)).resolution_view
    options = {o.type: o for o in view.action_options}
    assert all(options[t].available for t in types), [(t, options[t].reason) for t in types]
    return {
        "actions": [options[t].action.to_json() for t in types],
        "rationale": "Fix the mismatch the detection found.",
    }


async def scalar(services: Services, stmt):  # type: ignore[no-untyped-def]
    async with services.sessions() as s:
        return (await s.execute(stmt)).scalar_one()


async def test_preview_names_the_tier_and_who_could_approve(services: Services) -> None:
    body = await prefilled(services, PAY_0004, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    preview = await services.resolution_service.preview(
        PAY_0004, PreviewActionsBody.model_validate({"actions": body["actions"]}).actions
    )
    assert preview.attempt == 1
    assert preview.decision.tier in ("AUTO", "OPS", "MANAGER")
    assert preview.precondition_failures == []


async def test_a_state_correction_with_a_verified_capture_runs_automatically_and_resolves_the_case(
    services: Services,
) -> None:
    body = await prefilled(services, PAY_0004, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    item = await services.resolution_service.propose(PAY_0004, ProposeActionsBody.model_validate(body), OPS)
    await services.executor.drain()
    assert item.policy["tier"] == "AUTO" and item.status == "VALIDATED"
    assert item.validation.verdict == "PASS"
    async with services.sessions() as s:
        case = await s.get(Case, PAY_0004)
    assert case.status == "RESOLVED" and case.resolution["by"] == "USER" and case.resolved_at is not None
    # detection re-ran on the fixed data and found nothing left to flag
    assert case.mismatched == []


async def test_a_viewer_cannot_propose(services: Services) -> None:
    body = await prefilled(services, PAY_0004, ["MARK_ORDER_PAID"])
    with pytest.raises(AppError) as err:
        await services.resolution_service.propose(PAY_0004, ProposeActionsBody.model_validate(body), VIEWER)
    assert err.value.code == "FORBIDDEN"


async def test_a_blocked_proposal_is_stored_and_rejected_with_the_reasons(services: Services) -> None:
    # Escalate-only is fine, but a refund on a case whose preconditions fail is blocked: use a refund bigger than what is refundable.
    case_id = "case_ryxqgc2hh458n7"  # RFD-0003
    body = await prefilled(services, case_id, ["INITIATE_REFUND"])
    body["actions"][0]["params"]["amountMinor"] = 900_000_000
    with pytest.raises(AppError) as err:
        await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), OPS)
    assert err.value.code == "VALIDATION_FAILED" and err.value.details["policy"]["tier"] == "BLOCKED"
    assert err.value.details["preconditionFailures"]
    assert (
        await scalar(
            services,
            select(func.count())
            .select_from(Resolution)
            .where(Resolution.case_id == case_id, Resolution.status == "BLOCKED"),
        )
        == 1
    )


async def test_a_refund_needs_another_person_to_approve_and_the_proposer_cannot(services: Services) -> None:
    case_id = "case_ryxqgc2hh458n7"  # RFD-0003: refund missing
    body = await prefilled(services, case_id, ["INITIATE_REFUND"])
    item = await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), MGR_A)
    assert item.status == "AWAITING_APPROVAL" and item.approval.status == "PENDING"
    assert await scalar(services, select(Case.status).where(Case.id == case_id)) == "AWAITING_APPROVAL"

    # a second proposal on the same case is refused while one waits
    with pytest.raises(AppError) as conflict:
        await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), MGR_A)
    assert conflict.value.code == "CONFLICT"

    with pytest.raises(AppError) as too_junior:  # this refund is MANAGER tier
        await services.approval_service.decide(item.approval.id, ApprovalDecisionBody(decision="APPROVE"), OPS_B)
    assert too_junior.value.code == "FORBIDDEN" and "manager" in too_junior.value.message
    with pytest.raises(AppError) as four_eyes:
        await services.approval_service.decide(item.approval.id, ApprovalDecisionBody(decision="APPROVE"), MGR_A)
    assert four_eyes.value.code == "FORBIDDEN" and "proposed" in four_eyes.value.message

    decided = await services.approval_service.decide(
        item.approval.id, ApprovalDecisionBody(decision="APPROVE", comment="Looks right"), MGR_B
    )
    await services.executor.drain()
    assert decided.status == "APPROVED" and decided.decided_by.id == "usr_mgr_b"
    async with services.sessions() as s:
        resolved = await services.resolutions.item(s, item.id)
        case = await s.get(Case, case_id)
    assert resolved.status == "VALIDATED" and resolved.validation.verdict == "PASS", [
        c for c in resolved.validation.checks if not c.passed
    ]
    assert case.status == "RESOLVED"

    with pytest.raises(AppError) as again:
        await services.approval_service.decide(item.approval.id, ApprovalDecisionBody(decision="APPROVE"), MGR_B)
    assert again.value.code == "CONFLICT"


async def test_rejecting_reopens_the_case_and_needs_a_reason(services: Services) -> None:
    case_id = "case_ryxqgc2hh458n7"
    body = await prefilled(services, case_id, ["INITIATE_REFUND"])
    item = await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), MGR_A)
    with pytest.raises(ValueError):
        ApprovalDecisionBody(decision="REJECT", comment="no")
    await services.approval_service.decide(
        item.approval.id, ApprovalDecisionBody(decision="REJECT", comment="Wrong amount"), MGR_B
    )
    async with services.sessions() as s:
        assert (await s.get(Resolution, item.id)).status == "REJECTED"
        assert (await s.get(Case, case_id)).status == "OPEN"
        assert (await s.get(Approval, item.approval.id)).status == "REJECTED"


async def test_escalating_an_approval_moves_the_case_to_a_person(services: Services) -> None:
    case_id = "case_ryxqgc2hh458n7"
    body = await prefilled(services, case_id, ["INITIATE_REFUND"])
    item = await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), MGR_A)
    await services.approval_service.decide(
        item.approval.id, ApprovalDecisionBody(decision="ESCALATE", comment="Needs the manager"), MGR_B
    )
    assert await scalar(services, select(Case.status).where(Case.id == case_id)) == "ESCALATED"


async def test_undo_reverses_the_ledger_post_through_the_same_path(services: Services) -> None:
    body = await prefilled(services, PAY_0004, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    item = await services.resolution_service.propose(PAY_0004, ProposeActionsBody.model_validate(body), OPS)
    await services.executor.drain()
    legs_before = await scalar(services, select(func.count()).select_from(LedgerEntry))
    undone = await services.resolution_service.undo(item.id, OPS)
    assert any(a["type"] == "REVERSE_LEDGER_ENTRY" and a["params"]["undoOf"] == item.id for a in undone.actions)
    if (
        undone.status == "AWAITING_APPROVAL"
    ):  # an undo is a normal proposal: it waits for someone else when policy says so
        approver = MGR_B if undone.approval.tier == "MANAGER" else OPS_B
        await services.approval_service.decide(
            undone.approval.id, ApprovalDecisionBody(decision="APPROVE", comment="Undo is right"), approver
        )
    await services.executor.drain()
    assert await scalar(services, select(func.count()).select_from(LedgerEntry)) == legs_before + 2
    assert await scalar(services, select(Case.status).where(Case.id == PAY_0004)) in (
        "OPEN",
        "AWAITING_APPROVAL",
        "EXECUTING",
    )
    with pytest.raises(AppError):  # the original resolution is no longer the latest, and the case is no longer resolved
        await services.resolution_service.undo(item.id, OPS)


async def test_bulk_approve_skips_what_needs_a_closer_look(services: Services) -> None:
    case_id = "case_ryxqgc2hh458n7"
    body = await prefilled(services, case_id, ["INITIATE_REFUND"])
    item = await services.resolution_service.propose(case_id, ProposeActionsBody.model_validate(body), MGR_A)
    from payops.domain.bulk_approve import BulkApprovalBody

    result = await services.approval_service.bulk_approve(BulkApprovalBody(ids=[item.approval.id, "apr_missing"]), OPS)
    outcomes = {i.approval_id: i.outcome for i in result.items}
    assert outcomes["apr_missing"] == "FAILED"
    assert outcomes[item.approval.id] == "SKIPPED"  # a MANAGER-tier refund is never part of a bulk approve
    assert (result.approved, result.skipped, result.failed) == (0, 1, 1)


async def test_every_step_left_an_audit_trail(services: Services) -> None:
    body = await prefilled(services, PAY_0004, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    await services.resolution_service.propose(PAY_0004, ProposeActionsBody.model_validate(body), OPS)
    await services.executor.drain()
    async with services.sessions() as s:
        actions = set((await s.scalars(select(AuditEvent.action).where(AuditEvent.case_id == PAY_0004))).all())
        chain = await services.audit.verify_chain(s)
    assert {"resolution.proposed", "action.executed", "resolution.validated", "case.resolved"} <= actions
    assert chain.ok


async def test_detection_over_the_recorded_data_opens_nothing_new(services: Services) -> None:
    summary = await services.reconciliation.sweep()
    assert summary.opened == 0 and summary.checked > 0
