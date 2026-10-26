from __future__ import annotations

import hashlib
from typing import Any

from ...dto.actions import CatalogAction
from ...jsonjs import js_dumps


def stable_json(value: Any) -> str:
    """JSON with object keys sorted at every level, so equal params always serialise the same way (and the same as the
    TypeScript API)."""
    if isinstance(value, dict):
        entries = sorted(((k, v) for k, v in value.items() if v is not None), key=lambda kv: kv[0])
        return "{" + ",".join(f"{js_dumps(k)}:{stable_json(v)}" for k, v in entries) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_json(v) for v in value) + "]"
    return js_dumps(value)


def action_params_json(action: CatalogAction) -> dict[str, Any]:
    """The params as stored and hashed: camelCase keys, optional fields left out when not set."""
    return action.params.model_dump(mode="json", by_alias=True, exclude_none=True)


def idempotency_key(resolution_id: str, index: int, action: CatalogAction) -> str:
    """One key per (resolution, step, action): executing the same resolution again finds the stored execution instead of
    acting twice."""
    text = f"{resolution_id}|{index}|{action.type}|{stable_json(action_params_json(action))}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
