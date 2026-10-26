# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false, reportAttributeAccessIssue=false
"""The executor and validator against a real database, on the recorded scenarios: every step audited, replays never act twice, the validator reads
fresh data and says PASS only when the systems agree. (Replaces the executor and validator coverage of the TypeScript end-to-end tests.)"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime

import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.container import Services, build_services
from payops.db.engine import create_engine, session_factory, transaction
from payops.db.models import (
    AuditEvent,
    Case,
    Dispute,
    Execution,
    GwRefund,
    LedgerEntry,
    Payment,
    Refund,
    Resolution,
    WebhookEvent,
)
from payops.domain.actions.options import action_options
from payops.domain.ids import new_id
from payops.infra.snapshots import load_case_state
from payops.ports import FixedClock
from payops.services.audit import SYSTEM_ACTOR, WriteContext
from tests.conftest import load_contract_dump

NOW = datetime.fromisoformat(load_contract_dump()["now"])
OPS = WriteContext(actor=SYSTEM_ACTOR)


@pytest_asyncio.fixture
async def world(seeded_url: str) -> AsyncIterator[tuple[Services, AsyncEngine]]:
    engine = create_engine(url=seeded_url, pool_size=5)
    try:
        yield build_services(session_factory(engine), clock=FixedClock(NOW)), engine
    finally:
        await engine.dispose()


async def propose(services: Services, case_id: str, types: list[str]) -> str:
    """Stores a resolution made of the prefilled options for `types`, like a person who picked them in the form."""
    async with services.sessions() as s:
        state = await load_case_state(s, services.gateway, case_id, NOW)
    options = {o.type: o for o in action_options(state)}
    assert all(options[t].available for t in types), [(t, options[t].reason) for t in types]
    resolution_id = new_id("resolution")
    async with transaction(services.sessions) as s:
        s.add(
            Resolution(
                id=resolution_id,
                case_id=case_id,
                attempt=1,
                actions=[options[t].action.to_json() for t in types],
                rationale="test",
                status="EXECUTING",
                proposed_by={"type": "USER", "id": "usr_test", "name": "Test"},
                policy={"tier": "AUTO", "reasons": [], "version": "t", "moneyMovingMinor": 0, "riskTier": "LOW"},
                created_at=NOW,
                updated_at=NOW,
                run_id=None,
            )
        )
    return resolution_id


async def count(services: Services, model: type, *where: object) -> int:
    async with services.sessions() as s:
        return (await s.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


async def test_fixes_a_payment_mismatch_and_the_validator_passes(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    case_id = "case_w3wryfpvbpyt13"  # PAY-0004: captured at the gateway, order not paid, no ledger credit
    resolution_id = await propose(services, case_id, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    ledger_before = await count(services, LedgerEntry)

    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.ok and [s.status for s in outcome.steps] == ["SUCCEEDED", "SUCCEEDED"]
    assert await count(services, LedgerEntry) == ledger_before + 2  # one journal, two legs

    row = await services.validator.validate(resolution_id, OPS)
    assert row.verdict == "PASS", [c for c in row.checks if not c["pass"]]
    assert await count(services, AuditEvent, AuditEvent.action == "action.executed") >= 2
    assert await count(services, AuditEvent, AuditEvent.action == "resolution.validated") >= 1


async def test_executing_the_same_resolution_again_never_acts_twice(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    resolution_id = await propose(services, "case_w3wryfpvbpyt13", ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    first = await services.executor.execute(resolution_id, OPS)
    ledger_after_first = await count(services, LedgerEntry)
    second = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert first.ok and second.ok
    assert [s.idempotency_key for s in first.steps] == [s.idempotency_key for s in second.steps]
    assert await count(services, LedgerEntry) == ledger_after_first
    assert await count(services, Execution, Execution.resolution_id == resolution_id) == 2


async def test_a_step_whose_precondition_no_longer_holds_fails_and_stops_the_rest(
    world: tuple[Services, AsyncEngine],
) -> None:
    services, _ = world
    case_id = "case_w3wryfpvbpyt13"
    resolution_id = await propose(services, case_id, ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    # The world moves after the proposal: someone fixes the order by hand before it executes.
    other = await propose(services, case_id, ["MARK_ORDER_PAID"])
    assert (await services.executor.execute(other, OPS)).ok
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert not outcome.ok
    assert outcome.steps[0].status == "FAILED" and outcome.steps[0].error["code"] == "PRECONDITION_FAILED"
    assert outcome.steps[1].status == "SKIPPED"


async def test_validator_says_fail_when_a_postcondition_does_not_hold(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    resolution_id = await propose(services, "case_w3wryfpvbpyt13", ["MARK_ORDER_PAID", "POST_LEDGER_ENTRY"])
    row = await services.validator.validate(resolution_id, OPS)  # nothing was executed yet
    assert row.verdict == "FAIL"


async def test_holds_a_payment_and_audits_it(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    case_id = "case_w85ah0gpnwh3e0"  # RSK-0001
    resolution_id = await propose(services, case_id, ["HOLD_PAYMENT_FOR_REVIEW"])
    assert (await services.executor.execute(resolution_id, OPS)).ok
    await services.executor.drain()
    assert await count(services, Payment, Payment.hold.is_(True)) >= 1
    assert await count(services, AuditEvent, AuditEvent.action == "payment.held") == 1


async def test_escalates_a_case(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    case_id = "case_6baebtjk62r8vs"  # DUP-0001
    resolution_id = await propose(services, case_id, ["ESCALATE_TO_HUMAN"])
    assert (await services.executor.execute(resolution_id, OPS)).ok
    await services.executor.drain()
    async with services.sessions() as s:
        assert (await s.get(Case, case_id)).status == "ESCALATED"
    assert await count(services, AuditEvent, AuditEvent.action == "case.escalated") == 1


async def test_replaying_into_a_locked_order_is_answered_409_and_changes_nothing(
    world: tuple[Services, AsyncEngine],
) -> None:
    services, _ = world
    case_id = "case_9cpasct6pwgvd0"  # PAY-0002: the order service rejects webhook-driven changes (the replan scenario)
    resolution_id = await propose(services, case_id, ["REPLAY_WEBHOOK_EVENT"])
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED"
    assert "consumer answered HTTP 409, so nothing changed" in outcome.steps[0].summary
    async with services.sessions() as s:
        state = await load_case_state(s, services.gateway, case_id, NOW)
    assert state.order and state.order.order.status != "PAID"


async def test_replaying_a_failed_webhook_runs_our_consumer_and_fixes_the_order(
    world: tuple[Services, AsyncEngine],
) -> None:
    services, _ = world
    case_id = "case_2pqcg0k8rzkkxm"  # PAY-0003
    resolution_id = await propose(services, case_id, ["REPLAY_WEBHOOK_EVENT"])
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED", outcome.steps[0].summary
    assert "consumer answered HTTP 200" in outcome.steps[0].summary
    async with services.sessions() as s:
        state = await load_case_state(s, services.gateway, case_id, NOW)
    assert state.order and state.order.order.status == "PAID"
    assert await count(services, WebhookEvent, WebhookEvent.status == "PROCESSED") >= 1
    assert (await services.validator.validate(resolution_id, OPS)).verdict == "PASS"


async def test_a_refund_goes_through_the_gateway_and_posts_to_the_ledger(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    case_id = "case_ryxqgc2hh458n7"  # RFD-0003: refund missing
    refunds_before, ledger_before = await count(services, Refund), await count(services, LedgerEntry)
    resolution_id = await propose(services, case_id, ["INITIATE_REFUND"])
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED", outcome.steps[0].summary
    assert await count(services, Refund) == refunds_before + 1
    assert await count(services, LedgerEntry) == ledger_before + 2
    assert await count(services, GwRefund) == 4


async def test_syncing_a_pending_refund_brings_it_in_line_with_the_gateway(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    resolution_id = await propose(services, "case_hnr5m5k0gzv8v8", ["SYNC_REFUND_STATUS"])  # RFD-0004
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED", outcome.steps[0].summary


async def test_raises_a_settlement_dispute_once(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    resolution_id = await propose(services, "case_m79aar2h6p4gsf", ["RAISE_SETTLEMENT_DISPUTE"])  # STL-0002
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED", outcome.steps[0].summary
    assert await count(services, Dispute, Dispute.status == "OPEN") >= 1
    row = await services.validator.validate(resolution_id, OPS)
    assert row.verdict == "PASS", [c for c in row.checks if not c["pass"]]


async def test_reversing_a_journal_posts_equal_and_opposite_legs(world: tuple[Services, AsyncEngine]) -> None:
    services, _ = world
    ledger_before = await count(services, LedgerEntry)
    resolution_id = await propose(services, "case_43bththvvkxqbx", ["REVERSE_LEDGER_ENTRY"])  # DUP-0002
    outcome = await services.executor.execute(resolution_id, OPS)
    await services.executor.drain()
    assert outcome.steps[0].status == "SUCCEEDED", outcome.steps[0].summary
    assert await count(services, LedgerEntry) == ledger_before + 2
    async with services.sessions() as s:
        reversals = (await s.scalars(select(LedgerEntry).where(LedgerEntry.reversal_of.is_not(None)))).all()
    assert {leg.direction for leg in reversals} == {"DEBIT", "CREDIT"}
