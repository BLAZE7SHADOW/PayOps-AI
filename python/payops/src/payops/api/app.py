"""The FastAPI application factory. Kept free of `uvicorn.run` so tests can build it with their own settings and database."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncEngine

from .. import __version__
from ..auth.tokens import session_config
from ..container import Services, build_services
from ..db.engine import create_engine, ping, session_factory
from ..observability import RequestIdMiddleware, configure_logging
from ..ports import Clock, EventPublisher
from ..settings import Settings, get_settings
from .errors import install_error_handlers
from .routes import auth, ops, read, simulator, write
from .security import public_route
from .session_middleware import install_session_middleware


def create_app(
    settings: Settings | None = None, engine: AsyncEngine | None = None, *, clock: Clock | None = None, events: EventPublisher | None = None,
    services: Services | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = engine is None
        app.state.engine = engine or create_engine(settings)
        app.state.services = services or build_services(
            session_factory(app.state.engine), clock=clock, events=events, auth_config=app.state.session_config, demo_mode=settings.demo_mode,
            cassette_dir=settings.cassettes, reset_cooldown_seconds=0 if settings.node_env == "test" else 10,
        )
        try:
            yield
        finally:
            if owned:
                await app.state.engine.dispose()

    app = FastAPI(title="PayOps AI", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.session_config = session_config(settings.jwt_secret, settings.node_env)
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
