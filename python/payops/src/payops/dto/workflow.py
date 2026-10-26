"""Shift handoff shapes (packages/shared dto/workflow.ts)."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from .base import CamelModel


class HandoffNote(CamelModel):
    text: str
    author_name: str
    at: str


class HandoffCaseRef(CamelModel):
    id: str
    display_id: str
    type: str
    severity: str
    status: str
    amount_minor: int
    due_at: str | None
    overdue: bool
    assignee_name: str | None
    #: Why it is on the list, in code-written phrases: "Overdue", "Waiting for approval", "Critical".
    reasons: list[str]
    #: Newest operator note, if any.
    last_note: HandoffNote | None


class HandoffOpen(CamelModel):
    total: int
    overdue: int
    awaiting_approval: int
    unassigned: int
    by_severity: dict[str, int]


class HandoffResolved(CamelModel):
    total: int
    by: dict[str, int]


class HandoffRecentNote(CamelModel):
    case_id: str
    display_id: str
    text: str
    author_name: str
    at: str


class HandoffSummary(CamelModel):
    generated_at: str
    since_hours: int
    since: str
    open: HandoffOpen
    #: Open cases an incoming operator should look at first, most urgent first (max 10).
    needs_attention: list[HandoffCaseRef]
    resolved: HandoffResolved
    recent_notes: list[HandoffRecentNote]


class HandoffQuery(CamelModel):
    hours: Annotated[int, Field(ge=1, le=72)] = 8


class OperatorNoteItem(CamelModel):
    id: str
    case_id: str
    text: str
    author_id: str
    author_name: str
    created_at: str


class SavedViewItem(CamelModel):
    id: str
    name: str
    #: The filters exactly as the operator saved them (keys already camelCase).
    filters: dict[str, Any]
    created_at: str
