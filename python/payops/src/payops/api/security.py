"""Who is calling, and may they. Every route names its permission through `require_permission`; the route-guard test
fails any route that does not."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import Request

from ..domain.enums import role_at_least
from ..domain.permissions import role_for
from ..dto.base import CamelModel
from ..errors import AppError


class SessionUser(CamelModel):
    id: str
    email: str
    name: str
    role: str


def current_user(request: Request) -> SessionUser | None:
    """Set by the session middleware (or by a test) on `request.state.user`."""
    return getattr(request.state, "user", None)


def require_permission(permission: str, *, role_override: str | None = None) -> Callable[..., Any]:
    """A FastAPI dependency: 401 without a signed-in user, 403 when the role is below the one the permission names.
    `role_override` exists for the simulator, whose rule depends on DEMO_MODE."""
    needed = role_override or role_for(permission)

    async def dependency(request: Request) -> SessionUser:
        user = current_user(request)
        if user is None:
            raise AppError("UNAUTHENTICATED", "Sign in to continue")
        if not role_at_least(user.role, needed):
            raise AppError("FORBIDDEN", f"This needs the {needed} role or above")
        return user

    dependency.permission = permission  # type: ignore[attr-defined]  # read by the route-guard test
    return dependency


def public_route() -> Callable[..., Any]:
    """An explicitly open route (sign-in, health). It does nothing at runtime; it makes "no guard" a visible choice."""

    async def dependency() -> None:
        return None

    dependency.permission = "public"  # type: ignore[attr-defined]
    return dependency
