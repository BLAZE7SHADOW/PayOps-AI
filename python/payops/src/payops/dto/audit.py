from __future__ import annotations

from typing import Annotated

from pydantic import Field, StringConstraints

from .api import CursorQuery
from .base import CamelModel

_TRIM = StringConstraints(strip_whitespace=True, min_length=1, max_length=64)


class AuditListQuery(CursorQuery):
    case_id: Annotated[str, _TRIM] | None = None
    entity_id: Annotated[str, _TRIM] | None = None


class ActorRef(CamelModel):
    id: str
    name: str


class AuditEventItem(CamelModel):
    id: str
    at: str
    actor_type: str
    actor: ActorRef
    action: str
    entity_type: str
    entity_id: str
    summary: str
    run_id: str | None


class ChainHead(CamelModel):
    seq: int
    hash: str


class AuditChainStatus(CamelModel):
    """Result of walking the hash chain (D077). `head` is the newest verified link; keep it outside the database to detect a cut tail."""

    ok: bool
    checked: int
    head: ChainHead | None
    broken_at_seq: int | None
    broken_id: str | None
    reason: str | None


__all__ = ["ActorRef", "AuditChainStatus", "AuditEventItem", "AuditListQuery", "ChainHead", "Field"]
