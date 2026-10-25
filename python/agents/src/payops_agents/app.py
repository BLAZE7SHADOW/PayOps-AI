"""The Python agent service: `POST /runs` and `POST /runs/{id}/resume`, called by the TypeScript API's agent jobs.

Each call runs the graph to the end (or to the approval pause) and answers with the run's status, so the API's job lasts
as long as the run and keeps its retry behaviour (D085). Both calls are idempotent (see run.py).
"""

from __future__ import annotations

import hmac
import logging
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import __version__
from .checkpointer import checkpointer_ready, create_checkpointer
from .logging_setup import RequestIdMiddleware, configure_logging
from .node_api import NodeApi
from .ports import FixtureOptions
from .run import AgentRunner, RunConflict
from .settings import Settings, get_settings

log = logging.getLogger("payops.app")


class Fixture(BaseModel):
    rootCause: str
    consistent: float = 0.99
    replanStrategy: str = "escalate_to_human"

    def options(self) -> FixtureOptions:
        return FixtureOptions(self.rootCause, self.consistent, self.replanStrategy)


class StartBody(BaseModel):
    runId: str
    caseId: str
    scenarioKey: str | None = None
    aiMode: Literal["LIVE", "RECORD", "REPLAY"]
    fixture: Fixture | None = None


class Decision(BaseModel):
    approvalId: str | None = None
    decision: Literal["APPROVE", "REJECT", "ESCALATE"]
    decidedBy: dict[str, Any] | None = None
    comment: str | None = None


class ResumeBody(BaseModel):
    caseId: str
    scenarioKey: str | None = None
    aiMode: Literal["LIVE", "RECORD", "REPLAY"]
    decision: Decision
    fixture: Fixture | None = None


def create_app(runner: AgentRunner | None = None, settings: Settings | None = None) -> FastAPI:
    """`runner` and `settings` are injected by tests; the service builds its own from the environment."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            if runner is None:
                if not settings.secret_is_set:
                    raise RuntimeError("AGENT_INTERNAL_SECRET must be set (16 or more characters)")
                api = NodeApi(settings.node_api_url, settings.agent_internal_secret, timeout=settings.node_api_timeout_seconds)
                stack.push_async_callback(api.aclose)
                checkpointer = await create_checkpointer(stack, settings)
                app.state.checkpointer = checkpointer
                app.state.runner = AgentRunner(api, checkpointer)
            else:
                app.state.checkpointer = getattr(runner, "_checkpointer", None)
                app.state.runner = runner
            log.info("agent service ready", extra={"fields": {"version": __version__}})
            yield
            log.info("agent service stopping")

    app = FastAPI(title="PayOps agent service", version=__version__, lifespan=lifespan)
    app.add_middleware(RequestIdMiddleware)

    def authorize(given: str | None) -> None:
        if not settings.secret_is_set or not hmac.compare_digest((given or "").encode(), settings.agent_internal_secret.encode()):
            raise HTTPException(status_code=401, detail="Invalid agent service secret")

    def fixture_of(body: StartBody | ResumeBody) -> FixtureOptions | None:
        # Fixtures replace the model, so they exist for the eval harness only and are off unless asked for.
        if body.fixture is None:
            return None
        if not settings.agent_allow_fixtures:
            raise HTTPException(status_code=400, detail="Fixtures are disabled (set AGENT_ALLOW_FIXTURES=1 for evals)")
        return body.fixture.options()

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Liveness: the process is up. Use `/ready` to know it can take work."""
        return {"status": "ok", "version": __version__}

    @app.get("/ready")
    async def ready() -> dict[str, str]:
        if app.state.checkpointer is not None and not await checkpointer_ready(app.state.checkpointer):
            raise HTTPException(status_code=503, detail="Checkpoint store is unreachable")
        return {"status": "ready", "version": __version__}

    def answer(result: Any) -> dict[str, Any]:
        return {"status": result.status, "interrupted": result.interrupted, "state": result.state, "replay": result.replay}

    @app.post("/runs")
    async def start(body: StartBody, x_agent_secret: str | None = Header(default=None)) -> dict[str, Any]:
        authorize(x_agent_secret)
        try:
            result = await app.state.runner.investigate(body.runId, body.caseId, body.scenarioKey, body.aiMode, fixture=fixture_of(body))
        except RunConflict as err:
            raise HTTPException(status_code=409, detail=str(err)) from err
        return answer(result)

    @app.post("/runs/{run_id}/resume")
    async def resume(run_id: str, body: ResumeBody, x_agent_secret: str | None = Header(default=None)) -> dict[str, Any]:
        authorize(x_agent_secret)
        try:
            result = await app.state.runner.resume(
                run_id, body.caseId, body.scenarioKey, body.aiMode, body.decision.model_dump(), fixture=fixture_of(body)
            )
        except RunConflict as err:
            raise HTTPException(status_code=409, detail=str(err)) from err
        return answer(result)

    return app


def app_factory() -> FastAPI:
    """For `uvicorn payops_agents.app:app_factory --factory`."""
    return create_app()
