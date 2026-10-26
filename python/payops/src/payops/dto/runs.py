"""Agent run, step and diagnosis feedback shapes (packages/shared agents.ts). Run internals are stored as JSON and pass through as dicts."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from .api import CursorQuery
from .base import CamelModel
from .resolution import ExecutionStep
from .validation import ValidationCheck


class RunListQuery(CursorQuery):
    case_id: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    status: str | None = None


class RunValidation(CamelModel):
    verdict: str
    checks: list[ValidationCheck]


class AgentRunItem(CamelModel):
    id: str
    case_id: str
    resolution_id: str | None
    status: str
    path: str | None
    attempt: int
    budget: dict[str, Any]
    diagnosis: dict[str, Any] | None
    proposal: dict[str, Any] | None
    policy: dict[str, Any] | None
    approval_id: str | None
    #: Why the run ended early (provider failure, budget), for the handoff message. Null otherwise.
    error: str | None
    executions: list[ExecutionStep]
    validation: RunValidation | None
    findings: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    #: J4's final report. Null on the fast path and for runs recorded before this field existed.
    grounding: dict[str, Any] | None
    created_at: str
    updated_at: str
    finished_at: str | None


class AgentStepItem(CamelModel):
    id: str
    run_id: str
    seq: int
    node: str
    kind: str
    payload: dict[str, Any]
    at: str


class DiagnosisFeedbackItem(CamelModel):
    id: str
    run_id: str
    case_id: str
    #: The label the agent gave when the operator judged it. Kept so later edits cannot rewrite history.
    diagnosed_root_cause: str
    verdict: str
    reason: str
    correct_root_cause: str | None
    given_by_id: str
    given_by_name: str
    created_at: str
    updated_at: str
