"""The job queue. Four kinds of work, all run inside the API process by a worker that sleeps until Postgres NOTIFY wakes it:

- agent runs and resumes (one LangGraph thread each),
- the reconcile sweep (a cron job, off when RECONCILE_SWEEP_MS is 0),
- retries of failed inbound webhooks (delayed by the event log's backoff).

The handlers are plain methods on `JobHandlers`, so tests call them directly; the Procrastinate tasks only forward to them. Polling is kept long on purpose
(the hosted database bills egress, D083): NOTIFY handles immediate work, and the poll only picks up delayed jobs such as webhook retries."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Protocol

import procrastinate
from procrastinate import RetryStrategy
from procrastinate.connector import BaseConnector

if TYPE_CHECKING:
    from ..container import Services

log = logging.getLogger("payops.jobs")

QUEUES = ("agents", "sweeps", "webhooks")


class AgentJobs(Protocol):
    """What the agent jobs call. The in-process agent runner implements it (B5)."""

    async def start(self, run_id: str, case_id: str, scenario_key: str | None) -> None: ...
    async def resume(self, run_id: str, decision: str) -> None: ...


class JobQueue(Protocol):
    """What services use to schedule background work."""

    async def enqueue_agent_run(self, run_id: str, case_id: str, scenario_key: str | None) -> None: ...
    async def enqueue_agent_resume(self, run_id: str, decision: str) -> None: ...
    async def schedule(self, event_id: str, delay_seconds: int) -> None:
        """Schedules a retry of a failed inbound webhook (the event log calls this)."""
        ...


class JobHandlers:
    """The work itself. `services` is set once the container exists (the queue is built before it, because services schedule jobs through it)."""

    def __init__(self) -> None:
        self.services: Services | None = None
        self.agents: AgentJobs | None = None

    def _services(self) -> Services:
        if self.services is None:
            raise RuntimeError("jobs started before the services were ready")
        return self.services

    async def agent_run(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        if self.agents is None:
            raise RuntimeError("agent runner not configured")
        log.info("agent run starting", extra={"runId": run_id, "caseId": case_id})
        await self.agents.start(run_id, case_id, scenario_key)
        log.info("agent run job done", extra={"runId": run_id})

    async def agent_resume(self, run_id: str, decision: str) -> None:
        if self.agents is None:
            raise RuntimeError("agent runner not configured")
        log.info("agent run resuming", extra={"runId": run_id, "decision": decision})
        await self.agents.resume(run_id, decision)
        log.info("agent resume job done", extra={"runId": run_id})

    async def reconcile_sweep(self) -> dict[str, int]:
        """Re-checks recent orders and batches so faults that appear later (a rule's grace period passing, a 48h refund window closing) become cases without
        anyone generating data."""
        summary = await self._services().reconciliation.sweep()
        out = {"checked": summary.checked, "opened": summary.opened, "updated": summary.updated}
        log.info("reconcile sweep done", extra=out)
        return out

    async def webhook_retry(self, event_id: str) -> str:
        """The delay comes from the event log, which decides the backoff; the job only asks the log to retry. If the job runs early, or a person already
        replayed the event, `retry` does nothing."""
        outcome = await self._services().webhook_events.retry(event_id)
        log.info("webhook retry job done", extra={"eventId": event_id, "outcome": outcome})
        return outcome


class ProcrastinateJobs:
    """The queue backed by Postgres. Build it with a connector: a real one in the server, an in-memory one in tests."""

    def __init__(self, connector: BaseConnector, handlers: JobHandlers, *, sweep_enabled: bool) -> None:
        self.app = procrastinate.App(connector=connector)
        self.handlers = handlers
        agents_retry = RetryStrategy(max_attempts=3, wait=10)

        @self.app.task(name="agent_run", queue="agents", retry=agents_retry)
        async def agent_run(run_id: str, case_id: str, scenario_key: str | None = None) -> None:
            await handlers.agent_run(run_id, case_id, scenario_key)

        @self.app.task(name="agent_resume", queue="agents", retry=agents_retry)
        async def agent_resume(run_id: str, decision: str) -> None:
            await handlers.agent_resume(run_id, decision)

        @self.app.task(name="webhook_retry", queue="webhooks")
        async def webhook_retry(event_id: str) -> None:
            await handlers.webhook_retry(event_id)

        self._agent_run, self._agent_resume, self._webhook_retry = agent_run, agent_resume, webhook_retry
        if sweep_enabled:

            @self.app.periodic(cron="* * * * *")
            @self.app.task(name="reconcile_sweep", queue="sweeps", queueing_lock="reconcile_sweep")
            async def reconcile_sweep(timestamp: int) -> None:
                await handlers.reconcile_sweep()

    async def enqueue_agent_run(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        await self._agent_run.defer_async(run_id=run_id, case_id=case_id, scenario_key=scenario_key)

    async def enqueue_agent_resume(self, run_id: str, decision: str) -> None:
        await self._agent_resume.defer_async(run_id=run_id, decision=decision)

    async def schedule(self, event_id: str, delay_seconds: int) -> None:
        await self._webhook_retry.configure(schedule_in={"seconds": max(0, delay_seconds)}).defer_async(event_id=event_id)

    async def run_worker(self, **options: Any) -> None:
        """Runs until cancelled. Defaults keep idle traffic low: NOTIFY wakes the worker for new jobs, so polling is only for delayed ones, and the heartbeat
        is rare."""
        defaults: dict[str, Any] = {
            "queues": list(QUEUES), "concurrency": 2, "fetch_job_polling_interval": 30, "abort_job_polling_interval": 60, "update_heartbeat_interval": 300,
            "stalled_worker_timeout": 900, "install_signal_handlers": False, "name": "payops",
        }
        await self.app.run_worker_async(**{**defaults, **options})


class InlineJobs:
    """A queue that runs each job at once in the background of the same process. For tests and for running the API without a worker."""

    def __init__(self, handlers: JobHandlers) -> None:
        self.handlers = handlers
        self._tasks: set[asyncio.Task[Any]] = set()

    def _spawn(self, work: Any) -> None:
        task = asyncio.get_running_loop().create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def enqueue_agent_run(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        self._spawn(self.handlers.agent_run(run_id, case_id, scenario_key))

    async def enqueue_agent_resume(self, run_id: str, decision: str) -> None:
        self._spawn(self.handlers.agent_resume(run_id, decision))

    async def schedule(self, event_id: str, delay_seconds: int) -> None:
        """Retries are not run inline: a test advances its clock and calls the handler itself."""
        return None

    async def idle(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
