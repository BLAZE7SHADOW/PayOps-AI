"""Per-request session handling: read the cookie, and refuse state-changing requests that are not JSON (CSRF defence together with SameSite=Lax)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from ..auth.tokens import SESSION_COOKIE, verify_session
from ..errors import STATUS
from .errors import _body
from .security import SessionUser

STATE_CHANGING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def install_session_middleware(app: FastAPI) -> None:
    @app.middleware("http")
    async def read_session(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """Cookie signature first (cheap), then the sessions table. Never rejects; `require_permission` does that. A request without a valid cookie leaves
        `request.state.user` alone, so a test (or a trusted proxy) that set it keeps it."""
        token = request.cookies.get(SESSION_COOKIE)
        services = request.app.state.services
        claims = verify_session(token, request.app.state.session_config, services.clock.now()) if token else None
        if claims is not None:
            async with services.sessions() as s:
                active = await services.session_store.resolve(s, claims.session_id, claims.user_id)
                await s.commit()
            if active is not None:
                request.state.user = SessionUser(id=active.user_id, email=active.email, name=active.name, role=active.role)
                request.state.session_id = active.id
        return await call_next(request)

    @app.middleware("http")
    async def require_json(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """A cross-site HTML form can only send urlencoded, multipart or text/plain bodies, and a cross-site fetch with a JSON content type needs a CORS
        preflight our CORS policy refuses. Header check rather than body check, so a bodiless logout works."""
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if request.method in STATE_CHANGING and content_type != "application/json" and request.url.path.startswith("/api/"):
            body = _body("UNSUPPORTED_MEDIA_TYPE", "State-changing requests must send Content-Type: application/json")
            return JSONResponse(body, status_code=STATUS["UNSUPPORTED_MEDIA_TYPE"])
        return await call_next(request)
