"""A route without a declared guard is the classic way an endpoint ends up open by accident. This walks every route of the real app and fails if one has
neither `require_permission` nor an explicit `public_route()` marker. (port of apps/server permissions.test.ts)"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi.routing import APIRoute

from payops.api.app import create_app
from payops.domain.permissions import PERMISSIONS
from payops.settings import Settings

#: Permissions whose routes are not ported yet. This list only shrinks; it is empty when Phase B4 is done.
PENDING_PERMISSIONS = {"run.start", "simulator.use", "user.mfaReset", "user.sessionsRevoke", "account.security"}


def _guards(route: APIRoute) -> set[str]:
    found: set[str] = set()
    stack = [route.dependant]
    while stack:
        dep = stack.pop()
        permission = getattr(dep.call, "permission", None)
        if permission:
            found.add(permission)
        stack.extend(dep.dependencies)
    return found


def _walk(routes: Iterable[Any], prefix: str, out: dict[str, set[str]]) -> None:
    """FastAPI keeps included routers as nested objects, so the walk follows them and accumulates their prefixes."""
    for route in routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods):
                out[f"{method} {prefix}{route.path}"] = _guards(route)
        elif hasattr(route, "original_router"):
            _walk(route.original_router.routes, prefix + route.include_context.prefix, out)


def collect() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    _walk(create_app(Settings()).routes, "", out)
    return out


FOUND = collect()


def test_finds_the_routes() -> None:
    assert len(FOUND) > 30  # grows as the remaining routes (auth, simulator, runs) are ported


def test_every_route_names_a_permission_or_is_explicitly_public() -> None:
    assert [r for r, g in FOUND.items() if not g] == []


def test_every_permission_in_the_table_guards_at_least_one_route() -> None:
    used = set().union(*FOUND.values())
    unused = {p for p in PERMISSIONS if p not in used}
    assert unused == PENDING_PERMISSIONS & unused, f"unguarded permissions that are not on the pending list: {sorted(unused - PENDING_PERMISSIONS)}"


def test_the_pending_list_has_no_permission_that_is_already_used() -> None:
    used = set().union(*FOUND.values())
    assert PENDING_PERMISSIONS & used == set()
