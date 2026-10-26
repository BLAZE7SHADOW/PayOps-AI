"""Policy vocabulary shared by evaluation (`domain/policy`) and display (packages/shared policy.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from .base import CamelModel

POLICY_TIERS: Final = ("AUTO", "OPS", "MANAGER", "BLOCKED")
POLICY_TIER_RANK: Final = {"AUTO": 0, "OPS": 1, "MANAGER": 2, "BLOCKED": 3}
RISK_TIERS: Final = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
AGENT_CONTROL_MODES: Final = ("NORMAL", "PROPOSE_ONLY", "PAUSED")
POLICY_VERSION: Final = "2026-09-29.1"

PolicyTier = Literal["AUTO", "OPS", "MANAGER", "BLOCKED"]
RiskTier = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
ProposerType = Literal["USER", "AGENT"]
AgentControlMode = Literal["NORMAL", "PROPOSE_ONLY", "PAUSED"]


@dataclass(frozen=True)
class _Thresholds:
    auto_refund_max_minor: int = 1_000_00
    ops_refund_max_minor: int = 10_000_00
    auto_refund_min_confidence: float = 0.9
    auto_correction_min_confidence: float = 0.85
    low_confidence: float = 0.6


POLICY_THRESHOLDS: Final = _Thresholds()

POLICY_RULE_IDS: Final = ("P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12")


class PolicyReason(CamelModel):
    rule_id: str
    tier: PolicyTier
    reason: str


class PolicyDecision(CamelModel):
    tier: PolicyTier
    #: Every rule that fired; the strictest tier wins.
    reasons: list[PolicyReason]
    version: str
    #: Paise moved by the proposal (refunds).
    money_moving_minor: int
    risk_tier: RiskTier


@dataclass(frozen=True)
class PolicyRuleInfo:
    id: str
    condition: str
    tier: str
    applies_to: str


#: Human-readable rule table, rendered on the Policy page. Must describe exactly `domain/policy/rules.py`.
POLICY_RULES: Final = (
    PolicyRuleInfo("P0", "Proposal is empty, relies on findings that failed grounding, or fails a precondition", "BLOCKED", "all"),
    PolicyRuleInfo("P1", "Risk is CRITICAL and the proposal does anything other than hold or escalate", "BLOCKED", "all"),
    PolicyRuleInfo("P2", "Risk is HIGH or CRITICAL", "MANAGER", "all"),
    PolicyRuleInfo("P3", "Refunds over ₹10,000", "MANAGER", "all"),
    PolicyRuleInfo("P4", "Refunds over ₹1,000 up to ₹10,000", "OPS", "all"),
    PolicyRuleInfo("P5", "Refunds up to ₹1,000 with LOW risk (agent: confidence at least 0.90)", "AUTO", "all"),
    PolicyRuleInfo("P6", "State corrections only, gateway capture verified (agent: confidence at least 0.85)", "AUTO", "all"),
    PolicyRuleInfo("P7", "Second or later attempt on the same case", "at least OPS", "all"),
    PolicyRuleInfo("P8", "Agent diagnosis confidence below 0.60", "at least OPS", "agent"),
    PolicyRuleInfo("P9", "Claims against a third party (settlement disputes)", "OPS", "all"),
    PolicyRuleInfo("P10", "Hold or escalate only", "AUTO", "all"),
    PolicyRuleInfo("P11", "No rule above allows automatic execution (default)", "OPS", "all"),
    PolicyRuleInfo(
        "P12", "The agent is set to propose-only or paused, and the proposal does more than hold or escalate", "at least OPS", "agent"
    ),
)

#: Role needed to approve a tier. AUTO needs no approval; BLOCKED cannot be approved.
APPROVER_ROLE: Final = {"OPS": "OPS", "MANAGER": "MANAGER"}
