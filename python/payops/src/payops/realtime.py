"""Socket.IO room and event names (packages/shared events.ts, docs/03 §16). The web app subscribes to these exact
strings."""

from __future__ import annotations

from typing import Final

ROOM_OPS: Final = "ops"


def room_case(case_id: str) -> str:
    return f"case:{case_id}"


class OpsEvents:
    CASE_CREATED: Final = "case.created"
    CASE_UPDATED: Final = "case.updated"
    APPROVAL_REQUESTED: Final = "approval.requested"
    APPROVAL_RESOLVED: Final = "approval.resolved"
    #: A resolution attempt changed state (executing, validated, rejected...). Payload: ResolutionItem.
    RESOLUTION_UPDATED: Final = "resolution.updated"
