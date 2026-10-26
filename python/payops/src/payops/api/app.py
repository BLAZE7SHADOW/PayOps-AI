"""The FastAPI application factory. Kept free of `uvicorn.run` so tests can build it with their own settings and database."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from procrastinate import PsycopgConnector
from sqlalchemy.ext.asyncio import AsyncEngine

from .. import __version__
from ..agent_tools.runtime import AgentRuntime, QueueResumer
from ..agent_tools.store import AgentStore
from ..auth.tokens import session_config
from ..container import Services, build_services
from ..db.engine import create_engine, ping, session_factory
from ..jobs.queue import InlineJobs, JobHandlers, JobQueue, ProcrastinateJobs
from ..observability import RequestIdMiddleware, configure_logging
from ..ports import Clock, EventPublisher
from ..settings import Settings, get_settings
from .errors import install_error_handlers
from .routes import auth, ops, read, simulator, write
from .security import public_route
from .session_middleware import install_session_middleware
from .socket import Realtime


def create_app(
    settings: Settings | None = None, engine: AsyncEngine | None = None, *, clock: Clock | None = None, events: EventPublisher | None = None,
    services: Services | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    realtime = Realtime(settings.web_origin, session_config(settings.jwt_secret, settings.node_env), lambda: app.state.services)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = engine is None
        app.state.engine = engine or create_engine(settings)
        handlers = JobHandlers()
        queue: JobQueue
        if settings.jobs_mode == "inline":
            queue = InlineJobs(handlers)
        else:
            queue = ProcrastinateJobs(
                PsycopgConnector(conninfo=settings.database_url, kwargs={"autocommit": True}, min_size=1, max_size=4),
                handlers, sweep_enabled=settings.reconcile_sweep_ms > 0,
            )
        app.state.services = services or build_services(
            session_factory(app.state.engine), clock=clock, events=events or realtime, auth_config=app.state.session_config, demo_mode=settings.demo_mode,
            cassette_dir=settings.cassettes, reset_cooldown_seconds=0 if settings.node_env == "test" else 10, jobs=queue,
        )
        handlers.services = app.state.services
        app.state.jobs = queue
        realtime.attach_revocations()
        worker: asyncio.Task[None] | None = None
        async with AsyncExitStack() as stack:
            store = AgentStore(app.state.services.sessions, app.state.services.clock, app.state.services.events)
            app.state.agent_store = store
            agents = await AgentRuntime.create(stack, app.state.services, settings, store)
            app.state.agents = agents
            handlers.agents = agents
            app.state.services.approval_service.agent_resumer = QueueResumer(queue)
            if isinstance(queue, ProcrastinateJobs):
                await queue.app.open_async()
                worker = asyncio.get_running_loop().create_task(queue.run_worker(fetch_job_polling_interval=settings.job_poll_seconds))
            try:
                yield
            finally:
                if worker is not None:
                    worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)
                if isinstance(queue, ProcrastinateJobs):
                    await queue.app.close_async()
                if isinstance(queue, InlineJobs):
                    await queue.idle()
        if owned:
            await app.state.engine.dispose()

    app = FastAPI(title="PayOps AI", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.session_config = session_config(settings.jwt_secret, settings.node_env)
    app.state.realtime = realtime
    app.mount("/socket.io", realtime.asgi)
    install_error_handlers(app)
    install_session_middleware(app)
    app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(RequestIdMiddleware)

    api = APIRouter(prefix="/api")

    @api.get("/health", dependencies=[Depends(public_route())])
    async def health(response: Response) -> dict[str, object]:
        up = await ping(app.state.engine)
        response.status_code = 200 if up else 503
        return {"status": "ok" if up else "degraded", "checks": {"database": "ok" if up else "down"}, "aiMode": settings.ai_mode}

    api.include_router(auth.router)
    api.include_router(read.router)
    api.include_router(ops.router)
    api.include_router(write.router)
    api.include_router(simulator.make_router(settings.demo_mode))
    app.include_router(api)
    return app


def app_factory() -> FastAPI:
    """For `uvicorn payops.api.app:app_factory --factory`."""
    return create_app()
