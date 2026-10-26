# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The webhook log: receive, retry queue, manual replay (port of packages/core webhook-event.service.test.ts). The consumer is scripted per attempt."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from payops.db.engine import session_factory
from payops.db.models import AuditEvent
from payops.domain.gateway import GatewayWebhookDelivery, WebhookDeliveryResult
from payops.domain.timeutil import to_iso
from payops.domain.webhook_retry import WEBHOOK_MAX_ATTEMPTS
from payops.dto.webhooks import WebhookLogListQuery
from payops.errors import AppError
from payops.services.audit import AuditService
from payops.services.webhooks import WebhookQueryService
from payops.services.writes.webhooks import ConsumerResult, WebhookEventService


class MutableClock:
    def __init__(self, iso: str) -> None:
        self.moment = datetime.fromisoformat(iso)

    def now(self) -> datetime:
        return self.moment

    def advance(self, **kwargs: float) -> None:
        self.moment += timedelta(**kwargs)


def event(event_id: str = "evt_1") -> GatewayWebhookDelivery:
    return GatewayWebhookDelivery(
        id=event_id, event="payment.captured", gw_payment_id="gwpay_1", gw_refund_id=None, attempts=[], final_status="PENDING",
        created_at=datetime(2026, 9, 29, 9, 59, tzinfo=UTC),
    )


def answer(http_status: int, message: str | None = None) -> ConsumerResult:
    outcome = "PROCESSED" if http_status == 200 else "ORDER_VERSION_CONFLICT" if http_status == 409 else "ERROR"
    return ConsumerResult(http_status, outcome, message or f"answered {http_status}")


class Harness:
    def __init__(self, sessions: async_sessionmaker, clock: MutableClock) -> None:  # type: ignore[type-arg]
        self.sessions = sessions
        self.clock = clock
        self.answers: list[ConsumerResult] = []
        self.scheduled: list[tuple[str, int]] = []
        self.gateway_has_event = True
        self.service = WebhookEventService(sessions, clock, AuditService(clock), self, self, self)  # type: ignore[arg-type]

    # The consumer, the gateway and the scheduler are all this object, so each test scripts them in one place.
    async def handle(self, _event: GatewayWebhookDelivery) -> ConsumerResult:
        return self.answers.pop(0) if self.answers else answer(200)

    async def replay_webhook(self, event_id: str) -> WebhookDeliveryResult:
        if not self.gateway_has_event:
            raise AppError("NOT_FOUND", f"Webhook event {event_id} not found at the gateway")
        status = await self.service.receive(event(event_id))
        return WebhookDeliveryResult(status, to_iso(self.clock.now()))

    async def schedule(self, event_id: str, delay_seconds: int) -> None:
        self.scheduled.append((event_id, delay_seconds))

    async def get(self, event_id: str):  # type: ignore[no-untyped-def]
        async with self.sessions() as s:
            return await WebhookQueryService().get(s, event_id)


@pytest_asyncio.fixture
async def h(engine: AsyncEngine) -> AsyncIterator[Harness]:
    yield Harness(session_factory(engine), MutableClock("2026-09-29T10:00:00+00:00"))


async def test_logs_a_processed_event_with_its_payload_and_no_retry(h: Harness) -> None:
    h.answers = [answer(200, "Processed evt_1")]
    assert await h.service.receive(event()) == 200
    d = await h.get("evt_1")
    assert (d.status, d.attempt_count, d.next_retry_at) == ("PROCESSED", 1, None)
    assert d.payload["id"] == "evt_1" and d.payload["gwPaymentId"] == "gwpay_1"
    assert d.attempts[0]["source"] == "GATEWAY" and d.attempts[0]["httpStatus"] == 200 and d.attempts[0]["message"] == "Processed evt_1"
    assert h.scheduled == []


async def test_a_500_is_failed_and_queues_the_first_retry_in_one_minute(h: Harness) -> None:
    h.answers = [answer(500, "boom")]
    await h.service.receive(event())
    d = await h.get("evt_1")
    assert (d.status, d.last_http_status, d.next_retry_at) == ("FAILED", 500, "2026-09-29T10:01:00.000Z")
    assert h.scheduled == [("evt_1", 60)]


async def test_a_409_conflict_is_worth_retrying(h: Harness) -> None:
    h.answers = [answer(409)]
    await h.service.receive(event())
    assert (await h.get("evt_1")).status == "FAILED"


async def test_one_row_per_event_id_and_attempts_append(h: Harness) -> None:
    h.answers = [answer(500), answer(200)]
    await h.service.receive(event())
    await h.service.receive(event())
    d = await h.get("evt_1")
    assert [a["httpStatus"] for a in d.attempts] == [500, 200]
    assert (d.status, d.next_retry_at) == ("PROCESSED", None)


async def test_survives_the_queue_being_unavailable(h: Harness) -> None:
    class Broken:
        async def schedule(self, event_id: str, delay_seconds: int) -> None:
            raise RuntimeError("queue down")

    h.service.set_scheduler(Broken())
    h.answers = [answer(500)]
    assert await h.service.receive(event()) == 500
    assert (await h.get("evt_1")).status == "FAILED"


async def test_backs_off_on_each_failed_retry_and_then_goes_dead(h: Harness) -> None:
    h.answers = [answer(500) for _ in range(WEBHOOK_MAX_ATTEMPTS)]
    await h.service.receive(event())
    for _ in range(1, WEBHOOK_MAX_ATTEMPTS):
        h.clock.advance(hours=3)
        assert await h.service.retry("evt_1") == "RETRIED"
    assert [d for _, d in h.scheduled] == [60, 300, 1800, 7200]
    d = await h.get("evt_1")
    assert (d.status, d.attempt_count, d.next_retry_at) == ("DEAD", WEBHOOK_MAX_ATTEMPTS, None)
    assert all(a["source"] == "RETRY" for a in d.attempts[1:])
    async with h.sessions() as s:
        assert len((await s.scalars(select(AuditEvent).where(AuditEvent.action == "webhook.dead"))).all()) == 1


async def test_stops_retrying_once_an_attempt_succeeds(h: Harness) -> None:
    h.answers = [answer(500), answer(200)]
    await h.service.receive(event())
    h.clock.advance(seconds=61)
    assert await h.service.retry("evt_1") == "RETRIED"
    assert (await h.get("evt_1")).status == "PROCESSED"
    assert len(h.scheduled) == 1


async def test_skips_a_job_that_runs_before_the_event_is_due(h: Harness) -> None:
    h.answers = [answer(500)]
    await h.service.receive(event())
    assert await h.service.retry("evt_1") == "SKIPPED"
    assert (await h.get("evt_1")).attempt_count == 1


async def test_skips_events_that_are_processed_or_unknown(h: Harness) -> None:
    await h.service.receive(event("evt_ok"))
    assert await h.service.retry("evt_ok") == "SKIPPED"
    assert await h.service.retry("evt_missing") == "SKIPPED"


async def test_manual_replay_redelivers_through_the_gateway_and_audits_who(h: Harness) -> None:
    h.answers = [answer(500), answer(200)]
    await h.service.receive(event())
    d = await h.service.replay("evt_1", "usr_ops", "Ananya Rao")
    assert d.status == "PROCESSED" and d.attempts[1]["source"] == "MANUAL"
    async with h.sessions() as s:
        rows = (await s.scalars(select(AuditEvent).where(AuditEvent.action == "webhook.replayed"))).all()
    assert len(rows) == 1 and rows[0].actor_id == "usr_ops" and rows[0].entity_id == "evt_1"


async def test_replays_from_the_stored_payload_when_the_gateway_forgot_the_event(h: Harness) -> None:
    h.answers = [answer(500), answer(200)]
    await h.service.receive(event())
    h.gateway_has_event = False
    d = await h.service.replay("evt_1", "usr_ops", "Ananya Rao")
    assert d.status == "PROCESSED" and d.attempts[1]["source"] == "MANUAL" and d.attempts[1]["httpStatus"] == 200


async def test_a_dead_event_stays_dead_when_the_replay_fails_again(h: Harness) -> None:
    h.answers = [answer(500) for _ in range(WEBHOOK_MAX_ATTEMPTS + 1)]
    await h.service.receive(event())
    for _ in range(1, WEBHOOK_MAX_ATTEMPTS):
        h.clock.advance(hours=3)
        await h.service.retry("evt_1")
    before = len(h.scheduled)
    d = await h.service.replay("evt_1", "usr_ops", "Ananya Rao")
    assert (d.status, d.attempt_count) == ("DEAD", WEBHOOK_MAX_ATTEMPTS + 1)
    assert len(h.scheduled) == before


async def test_replay_rejects_an_unknown_event_id(h: Harness) -> None:
    with pytest.raises(AppError) as err:
        await h.service.replay("evt_nope", "usr_ops", "Ananya Rao")
    assert err.value.code == "NOT_FOUND"


async def test_list_filters_by_status_newest_first_and_counts(h: Harness) -> None:
    h.answers = [answer(200), answer(500), answer(200)]
    for name in ("evt_a", "evt_b", "evt_c"):
        await h.service.receive(event(name))
        h.clock.advance(seconds=1)
    q = WebhookQueryService()
    async with h.sessions() as s:
        assert [i.id for i in (await q.list(s, WebhookLogListQuery())).items] == ["evt_c", "evt_b", "evt_a"]
        assert [i.id for i in (await q.list(s, WebhookLogListQuery(status="FAILED"))).items] == ["evt_b"]
        c = await q.counts(s)
    assert (c.processed, c.failed, c.dead) == (2, 1, 0)


async def test_list_pages_with_a_cursor(h: Harness) -> None:
    for name in ("evt_a", "evt_b", "evt_c"):
        await h.service.receive(event(name))
        h.clock.advance(seconds=1)
    q = WebhookQueryService()
    async with h.sessions() as s:
        first = await q.list(s, WebhookLogListQuery(limit=2))
        assert len(first.items) == 2 and first.next_cursor is not None
        second = await q.list(s, WebhookLogListQuery(limit=2, cursor=first.next_cursor))
    assert [i.id for i in second.items] == ["evt_a"] and second.next_cursor is None
