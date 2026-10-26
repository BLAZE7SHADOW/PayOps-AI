"""Runs the agent graph inside the API process. Starting a run and resuming one paused for a person are both idempotent (the queue may deliver a job twice):
the graph's checkpoint decides what to do, and a run already executing here is left alone. (packages/agents run.ts, python/agents run.py)"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from typing import TYPE_CHECKING, Any

from payops_agents.checkpointer import checkpointer_ready, create_checkpointer
from payops_agents.run import AgentRunner, RunConflict, RunResult
from payops_agents.settings import Settings as AgentSettings

from ..errors import AppError
from .node_api import InProcessNodeApi
from .store import AgentStore

if TYPE_CHECKING:
    from ..container import Services
    from ..settings import Settings

log = logging.getLogger("payops.agents")


class AgentRuntime:
    """Implements the jobs' `AgentJobs` and the approvals' `AgentResumer`."""

    def __init__(self, services: Services, store: AgentStore, runner: AgentRunner, ai_mode: str, checkpointer: Any) -> None:
        self._services = services
        self.store = store
        self._runner = runner
        self._ai_mode = ai_mode
        self.checkpointer = checkpointer

    @classmethod
    async def create(cls, stack: AsyncExitStack, services: Services, settings: Settings, store: AgentStore) -> AgentRuntime:
        checkpointer = await create_checkpointer(
            stack, AgentSettings(database_url=settings.database_url, checkpointer=settings.checkpointer, checkpoint_pool_max=settings.checkpoint_pool_max)
        )
        runner = AgentRunner(InProcessNodeApi(services, store), checkpointer)
        return cls(services, store, runner, settings.ai_mode, checkpointer)

    async def ready(self) -> bool:
        return await checkpointer_ready(self.checkpointer)

    async def start(self, run_id: str, case_id: str, scenario_key: str | None) -> None:
        try:
            result = await self._runner.investigate(run_id, case_id, scenario_key, self._ai_mode)
        except RunConflict:
            log.warning("agent run is already executing, skipping this delivery", extra={"runId": run_id})
            return
        self._log(run_id, result)

    async def resume(self, run_id: str, decision: str) -> None:
        run = await self.store.get_run(run_id)
        if run is None:
            raise AppError("NOT_FOUND", f"agent run {run_id} not found")
        try:
            result = await self._runner.resume(run_id, run.case_id, run.scenario_key, self._ai_mode, {"approvalId": None, "decision": decision})
        except RunConflict as err:
            log.warning("agent run cannot be resumed now: %s", err, extra={"runId": run_id})
            return
        self._log(run_id, result)

    @staticmethod
    def _log(run_id: str, result: RunResult) -> None:
        log.info("agent run finished its turn", extra={"runId": run_id, "status": result.status, "interrupted": result.interrupted})


class QueueResumer:
    """Approvals resume a paused run through the queue, so the decision request returns at once."""

    def __init__(self, jobs: Any) -> None:
        self._jobs = jobs

    async def resume(self, run_id: str, decision: str) -> None:
        await self._jobs.enqueue_agent_resume(run_id, decision)
