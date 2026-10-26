"""The API contract: the OpenAPI description of the app, and the committed snapshot of it.

The snapshot (`tests/contract/openapi.json`) is what the web app is built against. A test fails when the app stops matching it, so an
API change is always a conscious, reviewed step: regenerate the snapshot, read the diff, and update the web app to follow.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..settings import Settings
from .app import create_app

SNAPSHOT = Path(__file__).resolve().parents[3] / "tests" / "contract" / "openapi.json"


def current_spec() -> dict[str, Any]:
    """The spec as the app is configured for tests. OpenAPI is built from the route definitions, so no database is contacted."""
    settings = Settings(
        jobs="inline", migrate_on_start=False, checkpointer="memory", database_url="postgres://x:y@127.0.0.1:1/x"
    )
    return create_app(settings).openapi()


def render(spec: dict[str, Any]) -> str:
    return json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def operations(spec: dict[str, Any]) -> set[str]:
    """`GET /api/cases/{case_id}` style keys, one per operation."""
    return {
        f"{method.upper()} {path}" for path, item in spec["paths"].items() for method in item if method != "parameters"
    }


def describe_drift(committed: dict[str, Any], current: dict[str, Any]) -> list[str]:
    """What changed, in words a reviewer can act on."""
    lines: list[str] = []
    old_ops, new_ops = operations(committed), operations(current)
    lines += [f"removed operation: {o}" for o in sorted(old_ops - new_ops)]
    lines += [f"added operation:   {o}" for o in sorted(new_ops - old_ops)]
    old_schemas = committed.get("components", {}).get("schemas", {})
    new_schemas = current.get("components", {}).get("schemas", {})
    lines += [f"removed schema:    {n}" for n in sorted(old_schemas.keys() - new_schemas.keys())]
    lines += [f"added schema:      {n}" for n in sorted(new_schemas.keys() - old_schemas.keys())]
    for name in sorted(old_schemas.keys() & new_schemas.keys()):
        if old_schemas[name] != new_schemas[name]:
            old_props, new_props = (
                set(old_schemas[name].get("properties", {})),
                set(new_schemas[name].get("properties", {})),
            )
            detail = ", ".join(
                [*(f"-{p}" for p in sorted(old_props - new_props)), *(f"+{p}" for p in sorted(new_props - old_props))]
            )
            lines.append(f"changed schema:    {name}" + (f" ({detail})" if detail else " (types or constraints)"))
    for op in sorted(old_ops & new_ops):
        method, path = op.split(" ", 1)
        if committed["paths"][path][method.lower()] != current["paths"][path][method.lower()]:
            lines.append(f"changed operation: {op}")
    return lines
