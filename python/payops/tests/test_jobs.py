# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""The job queue: tasks forward to the handlers, delayed jobs wait for their time, the sweep is only scheduled when enabled, and the handlers do the work."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest_asyncio
from procrastinate.testing import InMemoryConnector

from payops.container import build_services
from payops.db.engine import create_engine, session_factory
from payops.jobs.queue import InlineJobs, JobHandlers, ProcrastinateJobs
from payops.ports import FixedClock
from tests.test_execution import NOW


class RecordingAgents:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def start(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        self.calls.append(("start", run_id, case_id, scenario_key))

    async def resume(self, run_id: str, decision: str) -> None:
        self.calls.append(("resume", run_id, decision))


async def work(jobs: ProcrastinateJobs) -> None:
    """Runs every job that is due now, then returns."""
    await jobs.run_worker(wait=False, concurrency=1)


async def test_agent_jobs_reach_the_runner_with_their_arguments() -> None:
    handlers, agents = JobHandlers(), RecordingAgents()
    handlers.agents = agents
    jobs = ProcrastinateJobs(InMemoryConnector(), handlers, sweep_enabled=False)
    async with jobs.app.open_async():
        await jobs.enqueue_agent_run("run_1", "case_1", "captured_order_failed")
        await jobs.enqueue_agent_resume("run_1", "APPROVE")
        await work(jobs)
    assert agents.calls == [("start", "run_1", "case_1", "captured_order_failed"), ("resume", "run_1", "APPROVE")]


async def test_a_delayed_webhook_retry_waits_for_its_time() -> None:
    handlers = JobHandlers()
    seen: list[str] = []

    class Fake:
        async def retry(self, event_id: str) -> str:
            seen.append(event_id)
            return "RETRIED"

    class Services:
        webhook_events = Fake()

    handlers.services = Services()  # type: ignore[assignment]
    connector = InMemoryConnector()
    jobs = ProcrastinateJobs(connector, handlers, sweep_enabled=False)
    async with jobs.app.open_async():
        await jobs.schedule("evt_1", 3600)
        await work(jobs)
        assert seen == []  # an hour from now, not yet
        (job,) = connector.jobs.values()
        assert job["scheduled_at"] is not None and job["scheduled_at"] > NOW.replace(year=2000)
        job["scheduled_at"] = job["scheduled_at"] - timedelta(hours=2)  # time passes
        await work(jobs)
    assert seen == ["evt_1"]


async def test_the_sweep_is_scheduled_only_when_it_is_switched_on() -> None:
    on = ProcrastinateJobs(InMemoryConnector(), JobHandlers(), sweep_enabled=True)
    off = ProcrastinateJobs(InMemoryConnector(), JobHandlers(), sweep_enabled=False)
    assert "reconcile_sweep" in on.app.tasks and len(on.app.periodic_registry.periodic_tasks) == 1
    assert "reconcile_sweep" not in off.app.tasks and len(off.app.periodic_registry.periodic_tasks) == 0


@pytest_asyncio.fixture
async def seeded(seeded_url: str) -> AsyncIterator[tuple[Any, JobHandlers]]:
    engine = create_engine(url=seeded_url, pool_size=5)
    handlers = JobHandlers()
    services = build_services(session_factory(engine), clock=FixedClock(NOW), jobs=InlineJobs(handlers))
    handlers.services = services
    yield services, handlers
    await engine.dispose()


async def test_the_sweep_handler_checks_recent_data_and_opens_nothing_new(seeded: tuple[Any, JobHandlers]) -> None:
    _, handlers = seeded
    summary = await handlers.reconcile_sweep()
    assert summary["checked"] > 0 and summary["opened"] == 0


async def test_the_retry_handler_does_nothing_for_an_event_that_is_not_due(seeded: tuple[Any, JobHandlers]) -> None:
    _, handlers = seeded
    assert await handlers.webhook_retry("evt_missing") == "SKIPPED"


async def test_a_job_without_a_runner_fails_loudly(seeded: tuple[Any, JobHandlers]) -> None:
    _, handlers = seeded
    try:
        await handlers.agent_run("run_1", "case_1", None)
    except RuntimeError as err:
        assert "not configured" in str(err)
        return
    raise AssertionError("expected a RuntimeError")
