from __future__ import annotations

from ...dto.policy import POLICY_TIER_RANK, POLICY_VERSION, PolicyDecision, PolicyReason, PolicyTier
from .rules import POLICY_RULE_TABLE, PolicyInput, policy_facts


def evaluate_policy(inp: PolicyInput) -> PolicyDecision:
    """Runs every rule and keeps the strictest tier. AUTO has to be granted by a rule (P5, P6, P10); a proposal that no rule speaks for
    gets the explicit default rule P11 (OPS)."""
    facts = policy_facts(inp)
    reasons: list[PolicyReason] = []
    for _, rule in POLICY_RULE_TABLE:
        if (hit := rule(inp, facts)) is not None:
            reasons.append(hit)
    if not reasons:
        reasons.append(PolicyReason(rule_id="P11", tier="OPS", reason="No rule allows this proposal to run automatically"))
    tier: PolicyTier = "AUTO"
    for r in reasons:
        if POLICY_TIER_RANK[r.tier] > POLICY_TIER_RANK[tier]:
            tier = r.tier
    return PolicyDecision(tier=tier, reasons=reasons, version=POLICY_VERSION, money_moving_minor=facts.money_minor, risk_tier=inp.risk_tier)


def approver_hint(tier: str) -> str | None:
    """Who can approve a tier, in words for the UI."""
    if tier == "OPS":
        return "Another OPS user or a manager"
    if tier == "MANAGER":
        return "A manager"
    return None
