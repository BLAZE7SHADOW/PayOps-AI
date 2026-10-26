"""API request and response shapes (packages/shared dto/api.ts)."""

from __future__ import annotations

from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import ConfigDict, Field, StringConstraints, model_validator

from ..domain.enums import CASE_STATUS, CASE_TYPES, GW_PAYMENT_STATUS, ORDER_STATUS, SEVERITIES
from .base import CamelModel
from .matrix import LifecycleEvent, StateMatrix
from .metrics import PerformanceMetrics

T = TypeVar("T")

ISO_DATETIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
TrimmedStr = StringConstraints(strip_whitespace=True)


class Page(CamelModel, Generic[T]):
    omit_when_none = frozenset({"total"})

    items: list[T]
    next_cursor: str | None
    total: int | None = None


class CursorQuery(CamelModel):
    cursor: Annotated[str, Field(min_length=1)] | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 25


# ── Payments ─────────────────────────────────────────────────────────────────
class PaymentListQuery(CursorQuery):
    q: Annotated[str, TrimmedStr, Field(max_length=64)] | None = None
    gateway_status: Literal[GW_PAYMENT_STATUS] | None = None  # type: ignore[valid-type]
    order_status: Literal[ORDER_STATUS] | None = None  # type: ignore[valid-type]
    mismatch_only: Literal["true", "false"] | None = None
    from_: Annotated[str | None, Field(alias="from", pattern=ISO_DATETIME)] = None
    to: Annotated[str | None, Field(pattern=ISO_DATETIME)] = None


class PersonRef(CamelModel):
    id: str
    name: str
    email_masked: str


class MerchantRef(CamelModel):
    id: str
    name: str


class OpenCaseRef(CamelModel):
    id: str
    display_id: str


class PaymentListItem(CamelModel):
    payment_id: str
    gw_payment_id: str
    order_id: str
    created_at: str
    customer: PersonRef
    merchant: MerchantRef
    amount_minor: int
    method: str
    gateway_status: str
    internal_status: str
    order_status: str
    ledger: Literal["POSTED", "MISSING", "NOT_EXPECTED"]
    settlement: Literal["SETTLED", "PENDING", "MISMATCH", "NOT_EXPECTED"]
    mismatch: bool
    open_case: OpenCaseRef | None


class CardInfo(CamelModel):
    last4: str
    network: str
    country: str


class PaymentDetail(PaymentListItem):
    card: CardInfo | None
    lifecycle: list[LifecycleEvent]
    matrix: StateMatrix


# ── Cases ────────────────────────────────────────────────────────────────────
class CaseListQuery(CursorQuery):
    status: Literal[CASE_STATUS] | None = None  # type: ignore[valid-type]
    type: Literal[CASE_TYPES] | None = None  # type: ignore[valid-type]
    severity: Literal[SEVERITIES] | None = None  # type: ignore[valid-type]
    scope: Literal["open", "closed", "all"] = "open"
    #: A user id, or `unassigned`.
    assignee_id: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    #: `true` keeps only open cases past their due time.
    overdue: Literal["true", "false"] | None = None
    #: Display id (PAY-0042), case id, payment id or order id. Prefix match, case-insensitive.
    q: Annotated[str, TrimmedStr, Field(min_length=1, max_length=64)] | None = None


class CaseSignals(CamelModel):
    omit_when_none = frozenset({"complaint_type", "urgent", "quarantined"})

    complaint_type: str | None = None
    urgent: bool | None = None
    quarantined: bool | None = None


class AssigneeRef(CamelModel):
    id: str
    name: str


class PrimaryRef(CamelModel):
    omit_when_none = frozenset({"payment_id", "order_id", "batch_id"})

    payment_id: str | None = None
    order_id: str | None = None
    batch_id: str | None = None


class CaseListItem(CamelModel):
    id: str
    display_id: str
    type: str
    severity: str
    priority: int
    status: str
    amount_minor: int
    rule_ids: list[str]
    mismatched: list[str]
    signals: CaseSignals
    opened_at: str
    updated_at: str
    assignee: AssigneeRef | None
    #: When the case must be acted on by (SLA by severity). Null only for cases opened before D067.
    due_at: str | None
    #: Open and past `due_at`, computed by the server.
    overdue: bool
    primary_ref: PrimaryRef


# ── Overview ─────────────────────────────────────────────────────────────────
class OverviewMetrics(CamelModel):
    captured_today_minor: int
    captured_today_count: int
    open_exceptions: int
    awaiting_approval: int
    resolved7d: int = Field(alias="resolved7d")
    resolved_by_agent7d: int = Field(alias="resolvedByAgent7d")
    #: Validator verdicts recorded in the last 7 days (one row per verification, so a replanned case counts each
    #: attempt).
    validator_outcomes7d: dict[str, int] = Field(alias="validatorOutcomes7d")
    exceptions_by_type: list[dict[str, Any]]
    oldest_open: list[CaseListItem]
    performance: PerformanceMetrics


class AgentControlItem(CamelModel):
    mode: str
    reason: str
    changed_by_name: str | None
    changed_at: str | None


class AssignCaseBody(CamelModel):
    assignee_id: Annotated[str, Field(min_length=1, max_length=64)] | None


class AgentControlBody(CamelModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["NORMAL", "PROPOSE_ONLY", "PAUSED"]
    #: Why the switch changed. Required for anything other than NORMAL so the banner can say why.
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] = ""

    @model_validator(mode="after")
    def _needs_a_reason(self) -> AgentControlBody:
        if self.mode != "NORMAL" and len(self.reason) < 3:
            raise ValueError("Say briefly why the agent is being limited.")
        return self


class GenerateScenarioBody(CamelModel):
    scenario: str
    seed: Annotated[int, Field(ge=0, le=2**31)] | None = None
    #: Healthy background payments generated alongside the scenario.
    noise: Annotated[int, Field(ge=0, le=50)] = 0

    @model_validator(mode="after")
    def _known_scenario(self) -> GenerateScenarioBody:
        from ..simulator.scenario_info import SCENARIO_KEYS

        if self.scenario not in SCENARIO_KEYS:
            raise ValueError(f"Unknown scenario {self.scenario}")
        return self
