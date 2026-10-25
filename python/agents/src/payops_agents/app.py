"""The Python agent service: `POST /runs` and `POST /runs/{id}/resume`, called by the TypeScript API's agent jobs.

Each call runs the graph to the end (or to the approval pause) and answers with the run's status, so the
API's job lasts as long as the run and keeps its retry behaviour (D085). Needs `AGENT_INTERNAL_SECRET` (shared
with the API) and `NODE_API_URL` (where `/internal/agent` lives). `AI_MODE` comes with each call.
"""

from __future__ import annotations

import hmac
import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import __version__
from .checkpointer import create_checkpointer
from .node_api import NodeApi
from .ports import FixtureOptions
from .run import AgentRunner


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


def create_app(runner: AgentRunner | None = None, secret: str | None = None) -> FastAPI:
    """`runner` and `secret` are injected by tests; the service builds its own from the environment."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            if runner is None:
                api = NodeApi(os.environ.get("NODE_API_URL", "http://127.0.0.1:4000"), os.environ["AGENT_INTERNAL_SECRET"])
                stack.push_async_callback(api.aclose)
                app.state.runner = AgentRunner(api, await create_checkpointer(stack))
            else:
                app.state.runner = runner
            yield

    app = FastAPI(title="PayOps agent service", version=__version__, lifespan=lifespan)
    expected = secret if secret is not None else os.environ.get("AGENT_INTERNAL_SECRET", "")

    def fixture_of(body: StartBody | ResumeBody) -> FixtureOptions | None:
        # Fixtures replace the model, so they exist for the eval harness only and are off unless asked for.
        if body.fixture is None:
            return None
        if os.environ.get("AGENT_ALLOW_FIXTURES") != "1":
            raise HTTPException(status_code=400, detail="Fixtures are disabled (set AGENT_ALLOW_FIXTURES=1 for evals)")
        return body.fixture.options()

    def authorize(given: str | None) -> None:
        if not expected or not hmac.compare_digest((given or "").encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="Invalid agent service secret")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.post("/runs")
    async def start(body: StartBody, x_agent_secret: str | None = Header(default=None)) -> dict[str, Any]:
        authorize(x_agent_secret)
        result = await app.state.runner.investigate(
            body.runId, body.caseId, body.scenarioKey, body.aiMode, fixture=fixture_of(body)
        )
        return {"status": result.status, "interrupted": result.interrupted, "state": result.state, "replay": result.replay}

    @app.post("/runs/{run_id}/resume")
    async def resume(run_id: str, body: ResumeBody, x_agent_secret: str | None = Header(default=None)) -> dict[str, Any]:
        authorize(x_agent_secret)
        result = await app.state.runner.resume(
            run_id, body.caseId, body.scenarioKey, body.aiMode, body.decision.model_dump(), fixture=fixture_of(body)
        )
        return {"status": result.status, "interrupted": result.interrupted, "state": result.state, "replay": result.replay}

    return app


def app_factory() -> FastAPI:
    """For `uvicorn payops_agents.app:app_factory --factory`."""
    return create_app()
