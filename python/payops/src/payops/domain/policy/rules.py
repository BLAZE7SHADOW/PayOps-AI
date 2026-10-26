"""Policy rules P0 to P12 (docs/03-agent-system.md §11). Each rule is a small pure function that either fires with a
tier and a plain reason, or stays silent. The table shown to users is `POLICY_RULES` in `dto/policy.py` and must
describe exactly this code."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final

from ...dto.actions import ACTION_META, CRITICAL_RISK_ALLOWED, CatalogAction, money_moving_minor
from ...dto.policy import POLICY_THRESHOLDS, AgentControlMode, PolicyReason, PolicyTier, ProposerType, RiskTier
from ..money import format_money

T: Final = POLICY_THRESHOLDS


@dataclass(frozen=True)
class PolicyInput:
    proposer: ProposerType
    actions: Sequence[CatalogAction]
    risk_tier: RiskTier
    #: 1 for the first resolution attempt on a case.
    attempt: int
    #: The agent's diagnosis confidence (0 to 1). None for people.
    diagnosis_confidence: float | None
    #: Findings used by the proposal that failed grounding (agent only; 0 for people).
    grounding_violations: int
    precondition_failures: int
    #: The case's gateway payment is captured (people: checked by preconditions; agent: cited evidence).
    gateway_capture_verified: bool
    #: Operator switch for the agent (D066). Omitted means NORMAL.
    agent_control: AgentControlMode | None = None


@dataclass(frozen=True)
class PolicyFacts:
    """Facts derived once from the input so every rule reads the same numbers."""

    money_minor: int
    moves_money: bool
    only_state_correction: bool
    only_control: bool
    has_claim: bool
    is_agent: bool


def policy_facts(inp: PolicyInput) -> PolicyFacts:
    classes = [ACTION_META[a.type].action_class for a in inp.actions]
    non_empty = len(classes) > 0
    return PolicyFacts(
        money_minor=money_moving_minor(inp.actions),
        moves_money=any(ACTION_META[a.type].money_moving for a in inp.actions),
        only_state_correction=non_empty and all(c == "STATE_CORRECTION" for c in classes),
        only_control=non_empty and all(c == "CONTROL" for c in classes),
        has_claim="CLAIM" in classes,
        is_agent=inp.proposer == "AGENT",
    )


PolicyRule = Callable[[PolicyInput, PolicyFacts], PolicyReason | None]


def _fire(rule_id: str, tier: PolicyTier, reason: str) -> PolicyReason:
    return PolicyReason(rule_id=rule_id, tier=tier, reason=reason)


def _confidence(inp: PolicyInput) -> float:
    return inp.diagnosis_confidence if inp.diagnosis_confidence is not None else 0


def p0(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if len(inp.actions) == 0:
        return _fire("P0", "BLOCKED", "The proposal has no actions.")
    if inp.precondition_failures > 0:
        n = inp.precondition_failures
        return _fire("P0", "BLOCKED", f"{n} precondition{'' if n == 1 else 's'} failed on current data.")
    if inp.grounding_violations > 0:
        return _fire("P0", "BLOCKED", "The proposal relies on findings that failed grounding.")
    return None


def p1(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if inp.risk_tier != "CRITICAL":
        return None
    disallowed = [a for a in inp.actions if a.type not in CRITICAL_RISK_ALLOWED]
    if not disallowed:
        return None
    names = ", ".join(ACTION_META[a.type].label.lower() for a in disallowed)
    return _fire("P1", "BLOCKED", f"Risk is CRITICAL: only hold or escalate are allowed, not {names}.")


def p2(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    return _fire("P2", "MANAGER", f"Risk is {inp.risk_tier}.") if inp.risk_tier in ("HIGH", "CRITICAL") else None


def p3(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if f.moves_money and f.money_minor > T.ops_refund_max_minor:
        return _fire(
            "P3", "MANAGER", f"Refund of {format_money(f.money_minor)} is over {format_money(T.ops_refund_max_minor)}."
        )
    return None


def p4(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if f.moves_money and T.auto_refund_max_minor < f.money_minor <= T.ops_refund_max_minor:
        return _fire(
            "P4",
            "OPS",
            f"Refund of {format_money(f.money_minor)} is over {format_money(T.auto_refund_max_minor)} and up to {format_money(T.ops_refund_max_minor)}.",
        )
    return None


def p5(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if not f.moves_money or f.money_minor > T.auto_refund_max_minor or inp.risk_tier != "LOW":
        return None
    if f.is_agent and _confidence(inp) < T.auto_refund_min_confidence:
        return None
    return _fire(
        "P5",
        "AUTO",
        f"Refund of {format_money(f.money_minor)} is within {format_money(T.auto_refund_max_minor)} and risk is LOW.",
    )


def p6(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if not f.only_state_correction or not inp.gateway_capture_verified:
        return None
    if f.is_agent and _confidence(inp) < T.auto_correction_min_confidence:
        return None
    return _fire("P6", "AUTO", "State corrections only, and the gateway capture is verified.")


def p7(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if inp.attempt >= 2:
        return _fire("P7", "OPS", f"This is attempt {inp.attempt} on the case, so a person reviews it.")
    return None


def p8(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if not f.is_agent:
        return None
    if inp.diagnosis_confidence is not None and inp.diagnosis_confidence >= T.low_confidence:
        return None
    return _fire("P8", "OPS", "Agent diagnosis confidence is below 0.60.")


def p9(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    return _fire("P9", "OPS", "Raises a claim against a third party.") if f.has_claim else None


def p10(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    return _fire("P10", "AUTO", "Only holds or escalates; no money or records change.") if f.only_control else None


def p12(inp: PolicyInput, f: PolicyFacts) -> PolicyReason | None:
    if not f.is_agent or f.only_control:
        return None
    if inp.agent_control is None or inp.agent_control == "NORMAL":
        return None
    why = "The agent is paused" if inp.agent_control == "PAUSED" else "The agent is set to propose only"
    return _fire("P12", "OPS", f"{why}, so a person approves this fix.")


#: Evaluation order is display order; the outcome does not depend on it (strictest tier wins).
POLICY_RULE_TABLE: Final[tuple[tuple[str, PolicyRule], ...]] = (
    ("P0", p0),
    ("P1", p1),
    ("P2", p2),
    ("P3", p3),
    ("P4", p4),
    ("P5", p5),
    ("P6", p6),
    ("P7", p7),
    ("P8", p8),
    ("P9", p9),
    ("P10", p10),
    # P11 is the default: evaluate_policy adds it when no other rule fired.
    ("P11", lambda inp, f: None),
    ("P12", p12),
)
