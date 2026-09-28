/**
 * J3 weights and tier thresholds (docs/03-agent-system.md §4 "J3": `risk = Σ wᵢ·scoreᵢ` with
 * weights in `policies/risk.weights.ts`). Placed here in `packages/agents`, not
 * `packages/core/src/policy`, because J3's composition is a Risk-specialist concern that runs
 * inside the agent graph (nodes.ts `riskAgent`), not the policy engine: `core`'s policy already
 * has its own, unrelated rules-only risk tier (`policy/risk.ts`'s `riskTierFromRules`, computed
 * straight from order/attempt data for every proposal, agent or human) and consulting Jev's J3
 * output from inside `core` would violate the dependency direction `shared ← core ← agents`
 * (docs/DECISIONS.md has the full reasoning — search "risk.weights").
 *
 * Each of the four J3 Scores is 0-3 (docs/03 §4). Weights are chosen to sum to 1, so the
 * weighted composite stays in the same 0-3 range as a single score and the thresholds below read
 * as "roughly how many of the four signals are near their top level".
 */
import { RISK_TIERS_AGENT, type RiskAssessment } from '@payops/shared';

export const RISK_WEIGHTS = {
  // Highest weight: rapid repeated attempts/devices/cards is the strongest single fraud tell.
  velocity_abuse: 0.3,
  // A brand-new identity paired with mismatched signals is the next strongest tell.
  identity_mismatch: 0.25,
  // Customer-level dispute history (docs/DECISIONS.md: currently a coarse riskFlags proxy).
  chargeback_pattern: 0.25,
  // Merchant-level exposure is a weaker, indirect signal (it says more about the merchant than
  // this specific payment), so it gets the smallest share.
  merchant_exposure: 0.2,
} as const;

export type RiskScoreName = keyof typeof RISK_WEIGHTS;

/** Composite thresholds over the 0-3 weighted-average range: four evenly spaced tiers. */
const TIER_THRESHOLDS: { max: number; tier: (typeof RISK_TIERS_AGENT)[number] }[] = [
  { max: 0.75, tier: 'LOW' },
  { max: 1.5, tier: 'MEDIUM' },
  { max: 2.25, tier: 'HIGH' },
  { max: Infinity, tier: 'CRITICAL' },
];

export function tierForComposite(composite: number): (typeof RISK_TIERS_AGENT)[number] {
  return TIER_THRESHOLDS.find((t) => composite <= t.max)!.tier;
}

/** Raises a tier by one level, clamped at CRITICAL (docs/03 §4: "uncertainty is treated as
 * risk" — used both when Jev's mean confidence is under 0.5 and is exported so tests can assert
 * the clamp directly). */
export function raiseTierByOne(tier: (typeof RISK_TIERS_AGENT)[number]): (typeof RISK_TIERS_AGENT)[number] {
  const i = RISK_TIERS_AGENT.indexOf(tier);
  return RISK_TIERS_AGENT[Math.min(i + 1, RISK_TIERS_AGENT.length - 1)]!;
}

/** Code combination: `risk = Σ wᵢ·scoreᵢ` → tier, then the confidence-raises-tier-by-one rule
 * (docs/03 §4 "J3"). `scores` are Jev's four Score answers (each 0-3); `meanConfidence` is the
 * mean of their four `confidence` values. */
export function combineRiskScores(scores: Record<RiskScoreName, number>, meanConfidence: number): RiskAssessment {
  const composite = (Object.keys(RISK_WEIGHTS) as RiskScoreName[]).reduce(
    (sum, name) => sum + RISK_WEIGHTS[name] * scores[name],
    0,
  );
  let tier = tierForComposite(composite);
  if (meanConfidence < 0.5) tier = raiseTierByOne(tier);
  return { tier, scores, meanConfidence };
}
