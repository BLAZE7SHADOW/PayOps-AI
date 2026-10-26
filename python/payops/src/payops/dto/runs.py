"""Agent run, step and diagnosis feedback shapes (packages/shared agents.ts). Run internals are stored as JSON and pass through as dicts."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import ConfigDict, Field, StringConstraints, model_validator

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


ROOT_CAUSES = (
    "WEBHOOK_PROCESSING_FAILURE", "WEBHOOK_NOT_DELIVERED", "ORDER_STATE_DIVERGED", "LEDGER_POSTING_MISSING", "DUPLICATE_CAPTURE", "REFUND_STATUS_NOT_SYNCED",
    "REFUND_NOT_INITIATED", "REFUND_FAILED_AT_GATEWAY", "SETTLEMENT_FEE_MISMATCH", "SETTLEMENT_LINE_MISSING", "SUSPECTED_FRAUD", "UNKNOWN",
)
RootCauseName = Literal[
    "WEBHOOK_PROCESSING_FAILURE", "WEBHOOK_NOT_DELIVERED", "ORDER_STATE_DIVERGED", "LEDGER_POSTING_MISSING", "DUPLICATE_CAPTURE", "REFUND_STATUS_NOT_SYNCED",
    "REFUND_NOT_INITIATED", "REFUND_FAILED_AT_GATEWAY", "SETTLEMENT_FEE_MISMATCH", "SETTLEMENT_LINE_MISSING", "SUSPECTED_FRAUD", "UNKNOWN",
]


class DiagnosisFeedbackBody(CamelModel):
    """A "wrong" verdict needs a reason, so the feedback is usable later (metrics, new checks)."""

    model_config = ConfigDict(extra="forbid")

    verdict: Literal["RIGHT", "WRONG"]
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    #: What the operator believes the cause was; only meaningful for a WRONG verdict.
    correct_root_cause: RootCauseName | None = None

    @model_validator(mode="after")
    def _wrong_needs_a_reason(self) -> DiagnosisFeedbackBody:
        if self.verdict == "WRONG" and len(self.reason) < 3:
            raise ValueError("Say briefly why the diagnosis is wrong.")
        return self


class CreateRunBody(CamelModel):
    model_config = ConfigDict(extra="forbid")

    #: For RECORD and REPLAY only: which cassette file to use (docs/03 §14). Ignored in LIVE.
    scenario_key: str | None = None

    @model_validator(mode="after")
    def _known_scenario(self) -> CreateRunBody:
        from ..simulator.scenario_info import SCENARIO_KEYS

        if self.scenario_key is not None and self.scenario_key not in SCENARIO_KEYS:
            raise ValueError(f"Unknown scenario {self.scenario_key}")
        return self
