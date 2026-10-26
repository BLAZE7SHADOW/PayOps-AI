"""Sign-in and account security routes. The routes set and clear the session cookie; every rule is in `services/auth.py`."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response

from ...auth.tokens import SESSION_COOKIE, SESSION_TTL_SECONDS, SessionConfig
from ...dto.security import (
    DemoLoginBody,
    LoginBody,
    MfaChallengeResponse,
    MfaCodeBody,
    MfaLoginBody,
    MfaSetupResponse,
    SecurityOverview,
)
from ...errors import AppError
from ...services.auth import MfaRequired, SignedIn
from ..deps import ServicesDep, ident
from ..security import SessionUser, current_user, public_route, require_permission

router = APIRouter(prefix="/auth")


def client_ip(request: Request) -> str:
    """Behind one proxy (Vercel, Render) the client is the last hop the proxy recorded; otherwise the socket peer."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _set_cookie(response: Response, token: str, config: SessionConfig) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, httponly=True, samesite="lax", secure=config.secure, path="/")


def _clear_cookie(response: Response, config: SessionConfig) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="lax", secure=config.secure, path="/")


def _answer(result: SignedIn | MfaRequired, request: Request, response: Response) -> dict[str, Any]:
    if isinstance(result, MfaRequired):
        return MfaChallengeResponse(mfa_required=True, challenge=result.challenge).to_json()
    _set_cookie(response, result.token, request.app.state.session_config)
    return result.user


def _user(request: Request) -> SessionUser:
    user = current_user(request)
    if user is None:
        raise AppError("UNAUTHENTICATED", "Sign in to continue")
    return user


def _session_id(request: Request) -> str | None:
    return getattr(request.state, "session_id", None)


@router.post("/login", dependencies=[Depends(public_route())])
async def login(body: LoginBody, request: Request, response: Response, services: ServicesDep) -> dict[str, Any]:
    result = await services.auth.login(body.email, body.password, client_ip(request), request.headers.get("user-agent", ""))
    return _answer(result, request, response)


@router.post("/login/mfa", dependencies=[Depends(public_route())])
async def login_mfa(body: MfaLoginBody, request: Request, response: Response, services: ServicesDep) -> dict[str, Any]:
    result = await services.auth.login_mfa(body.challenge, body.code, client_ip(request), request.headers.get("user-agent", ""))
    return _answer(result, request, response)


@router.post("/demo-login", dependencies=[Depends(public_route())])
async def demo_login(body: DemoLoginBody, request: Request, response: Response, services: ServicesDep) -> dict[str, Any]:
    result = await services.auth.demo_login(body.email, client_ip(request), request.headers.get("user-agent", ""))
    return _answer(result, request, response)


@router.post("/logout", dependencies=[Depends(public_route())])
async def logout(request: Request, response: Response, services: ServicesDep) -> dict[str, str]:
    await services.auth.logout(_session_id(request))
    _clear_cookie(response, request.app.state.session_config)
    return {"status": "ok"}


@router.get("/me", dependencies=[Depends(public_route())])
async def me(request: Request) -> dict[str, str]:
    user = current_user(request)
    if user is None:
        raise AppError("UNAUTHENTICATED", "Not signed in")
    return user.to_json()  # type: ignore[return-value]


@router.get("/demo-accounts", dependencies=[Depends(public_route())])
async def demo_accounts(services: ServicesDep) -> list[dict[str, str]]:
    return services.auth.demo_accounts()


@router.get("/security")
async def security(request: Request, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]) -> SecurityOverview:
    async with services.sessions() as s:
        return await services.auth.security_overview(s, user.id, user.role, _session_id(request))


@router.post("/mfa/setup")
async def mfa_setup(services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]) -> MfaSetupResponse:
    return await services.auth.mfa_setup(user.id)


@router.post("/mfa/enable")
async def mfa_enable(
    body: MfaCodeBody, request: Request, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]
) -> dict[str, object]:
    return await services.auth.mfa_enable(user.id, user.name, body.code, _session_id(request))


@router.post("/mfa/disable")
async def mfa_disable(body: MfaCodeBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]) -> dict[str, object]:
    return await services.auth.mfa_disable(user.id, user.name, body.code)


@router.post("/users/{user_id}/mfa/reset")
async def mfa_reset(user_id: str, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("user.mfaReset"))]) -> dict[str, object]:
    return await services.auth.mfa_reset(user.id, user.name, ident(user_id))


@router.post("/sessions/revoke-others")
async def revoke_others(
    request: Request, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]
) -> dict[str, int]:
    return await services.auth.revoke_others(user.id, user.name, _session_id(request))


@router.post("/sessions/{session_id}/revoke")
async def revoke_session(
    session_id: str, request: Request, response: Response, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("account.security"))]
) -> dict[str, bool]:
    revoked = await services.auth.revoke_session(user.id, user.name, user.role, session_id)
    if session_id == _session_id(request):
        _clear_cookie(response, request.app.state.session_config)
    return {"revoked": revoked}


@router.post("/users/{user_id}/sessions/revoke")
async def revoke_user_sessions(
    user_id: str, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("user.sessionsRevoke"))]
) -> dict[str, int]:
    return await services.auth.revoke_all_of_user(user.id, user.name, ident(user_id))

