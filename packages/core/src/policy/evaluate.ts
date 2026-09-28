import {
  POLICY_TIER_RANK,
  POLICY_VERSION,
  type PolicyDecision,
  type PolicyReason,
  type PolicyTier,
} from '@payops/shared';
import { POLICY_RULE_TABLE, policyFacts, type PolicyInput } from './rules';

/**
 * Runs every rule and keeps the strictest tier. AUTO has to be granted by a rule (P5, P6, P10);
 * a proposal that no rule speaks for gets the explicit default rule P11 (OPS).
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const facts = policyFacts(input);
  const reasons: PolicyReason[] = [];
  for (const { rule } of POLICY_RULE_TABLE) {
    const hit = rule(input, facts);
    if (hit) reasons.push(hit);
  }
  // Default rule: nothing granted AUTO and nothing raised the tier, so a person decides.
  if (reasons.length === 0) {
    reasons.push({ ruleId: 'P11', tier: 'OPS', reason: 'No rule allows this proposal to run automatically' });
  }
  const tier = reasons.reduce<PolicyTier>(
    (best, r) => (POLICY_TIER_RANK[r.tier] > POLICY_TIER_RANK[best] ? r.tier : best),
    'AUTO',
  );
  return { tier, reasons, version: POLICY_VERSION, moneyMovingMinor: facts.moneyMinor, riskTier: input.riskTier };
}

/** Who can approve a tier, in words for the UI. */
export function approverHint(tier: PolicyTier): string | null {
  if (tier === 'OPS') return 'Another OPS user or a manager';
  if (tier === 'MANAGER') return 'A manager';
  return null;
}
