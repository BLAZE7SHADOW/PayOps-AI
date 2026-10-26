"""Resolutions, approvals and the case page's resolution view (packages/shared dto/resolution.ts).

`actions`, `policy`, `budget` and the like are stored as JSON in exactly the shape the web app reads, so they pass through as plain dicts.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, StringConstraints, model_validator

from .actions import CatalogAction
from .base import CamelModel
from .policy import PolicyDecision
from .validation import ActionOption, PreconditionFailure, ValidationCheck

#: PENDING, APPROVED, REJECTED or ESCALATED; OPS or MANAGER. Plain strings because they come straight from the database.
ApprovalStatus = str
ApprovalTier = str


class ActorRef(CamelModel):
    type: str
    id: str
    name: str


class ExecutionStep(CamelModel):
    index: int
    type: str
    #: STARTED, SUCCEEDED, FAILED or SKIPPED.
    status: str
    idempotency_key: str
    #: Plain-language outcome, e.g. "Gateway re-delivered payment.captured: consumer answered HTTP 409".
    summary: str
    error: dict[str, Any] | None
    #: Source records just before this step acted. Null for skipped steps and steps run before D060.
    before: list[dict[str, Any]] | None
    started_at: str
    finished_at: str | None


class ValidationResultDto(CamelModel):
    id: str
    verdict: str
    checks: list[ValidationCheck]
    at: str


class ApprovalSummary(CamelModel):
    id: str
    tier: ApprovalTier
    status: ApprovalStatus
    decided_by: ActorRef | None
    comment: str | None
    decided_at: str | None


class ResolutionItem(CamelModel):
    id: str
    case_id: str
    run_id: str | None
    attempt: int
    status: str
    actions: list[dict[str, Any]]
    rationale: str
    proposed_by: ActorRef
    policy: dict[str, Any]
    approval: ApprovalSummary | None
    executions: list[ExecutionStep]
    validation: ValidationResultDto | None
    created_at: str
    updated_at: str


class CaseResolutionView(CamelModel):
    action_options: list[ActionOption]
    resolutions: list[ResolutionItem]
    #: Pending approval id if the case is waiting on a decision.
    pending_approval_id: str | None
    #: Whether the viewer may propose a manual resolution now, and why not.
    can_propose: bool
    cannot_propose_reason: str | None


class ApprovalListQuery(CamelModel):
    cursor: Annotated[str, Field(min_length=1)] | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 25
    scope: Literal["pending", "decided", "all"] = "pending"


class ApprovalCase(CamelModel):
    id: str
    display_id: str
    type: str
    status: str
    amount_minor: int


class ApprovalItem(CamelModel):
    id: str
    case: ApprovalCase
    resolution_id: str
    tier: ApprovalTier
    status: ApprovalStatus
    #: e.g. "Refund customer ₹78,000.00" or "Hold payment · Escalate".
    actions_summary: str
    action_types: list[str]
    money_moving_minor: int
    risk_tier: str
    rule_ids: list[str]
    requested_by: ActorRef
    requested_at: str
    decided_by: ActorRef | None
    decided_at: str | None
    comment: str | None
    #: Evaluated for the current viewer: role and four-eyes.
    can_decide: bool
    cannot_decide_reason: str | None


# ── Proposals and decisions ──────────────────────────────────────────────────
class ProposeActionsBody(CamelModel):
    actions: Annotated[list[CatalogAction], Field(min_length=1, max_length=6)]
    rationale: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1000)]


class PreviewActionsBody(CamelModel):
    actions: Annotated[list[CatalogAction], Field(min_length=1, max_length=6)]


class PolicyPreview(CamelModel):
    decision: PolicyDecision
    precondition_failures: list[PreconditionFailure]
    #: Who could approve if approval is needed, e.g. "Another OPS user" / "A manager".
    approver_hint: str | None
    attempt: int


class ApprovalDecisionBody(CamelModel):
    decision: Literal["APPROVE", "REJECT", "ESCALATE"]
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""

    @model_validator(mode="after")
    def _needs_a_reason(self) -> ApprovalDecisionBody:
        if self.decision != "APPROVE" and len(self.comment) < 5:
            raise ValueError("A comment of at least 5 characters is required to reject or escalate")
        return self
