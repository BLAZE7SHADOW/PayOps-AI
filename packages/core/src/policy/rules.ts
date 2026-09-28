/**
 * Policy rules P0–P10 (docs/03-agent-system.md §11). Each rule is a small pure function that
 * either fires with a tier and a plain reason, or stays silent. The table shown to users is
 * POLICY_RULES in packages/shared/src/policy.ts and must describe exactly this code.
 */
import {
  ACTION_META,
  CRITICAL_RISK_ALLOWED,
  POLICY_THRESHOLDS,
  formatMoney,
  moneyMovingMinor,
  type CatalogAction,
  type PolicyReason,
  type PolicyRuleId,
  type PolicyTier,
  type ProposerType,
  type RiskTier,
} from '@payops/shared';

export interface PolicyInput {
  proposer: ProposerType;
  actions: readonly CatalogAction[];
  riskTier: RiskTier;
  /** 1 for the first resolution attempt on a case. */
  attempt: number;
  /** Agent's diagnosis confidence (0–1). Null for people. */
  diagnosisConfidence: number | null;
  /** Findings used by the proposal that failed grounding (agent only; 0 for people). */
  groundingViolations: number;
  preconditionFailures: number;
  /** The case's gateway payment is captured (people: checked by preconditions; agent: cited evidence). */
  gatewayCaptureVerified: boolean;
}

/** Facts derived once from the input so every rule reads the same numbers. */
export interface PolicyFacts {
  moneyMinor: number;
  movesMoney: boolean;
  onlyStateCorrection: boolean;
  onlyControl: boolean;
  hasClaim: boolean;
  isAgent: boolean;
}

export function policyFacts(input: PolicyInput): PolicyFacts {
  const classes = input.actions.map((a) => ACTION_META[a.type].actionClass);
  const nonEmpty = classes.length > 0;
  return {
    moneyMinor: moneyMovingMinor(input.actions),
    movesMoney: input.actions.some((a) => ACTION_META[a.type].moneyMoving),
    onlyStateCorrection: nonEmpty && classes.every((c) => c === 'STATE_CORRECTION'),
    onlyControl: nonEmpty && classes.every((c) => c === 'CONTROL'),
    hasClaim: classes.includes('CLAIM'),
    isAgent: input.proposer === 'AGENT',
  };
}

export type PolicyRule = (input: PolicyInput, facts: PolicyFacts) => PolicyReason | null;

const fire = (ruleId: PolicyRuleId, tier: PolicyTier, reason: string): PolicyReason => ({ ruleId, tier, reason });
const T = POLICY_THRESHOLDS;
const confidence = (input: PolicyInput) => input.diagnosisConfidence ?? 0;

const P0: PolicyRule = (input) => {
  if (input.actions.length === 0) return fire('P0', 'BLOCKED', 'The proposal has no actions.');
  if (input.preconditionFailures > 0) {
    const n = input.preconditionFailures;
    return fire('P0', 'BLOCKED', `${n} precondition${n === 1 ? '' : 's'} failed on current data.`);
  }
  if (input.groundingViolations > 0) return fire('P0', 'BLOCKED', 'The proposal relies on findings that failed grounding.');
  return null;
};

const P1: PolicyRule = (input) => {
  if (input.riskTier !== 'CRITICAL') return null;
  const disallowed = input.actions.filter((a) => !CRITICAL_RISK_ALLOWED.includes(a.type));
  if (disallowed.length === 0) return null;
  return fire('P1', 'BLOCKED', `Risk is CRITICAL: only hold or escalate are allowed, not ${disallowed.map((a) => ACTION_META[a.type].label.toLowerCase()).join(', ')}.`);
};

const P2: PolicyRule = (input) =>
  input.riskTier === 'HIGH' || input.riskTier === 'CRITICAL' ? fire('P2', 'MANAGER', `Risk is ${input.riskTier}.`) : null;

const P3: PolicyRule = (_input, f) =>
  f.movesMoney && f.moneyMinor > T.opsRefundMaxMinor
    ? fire('P3', 'MANAGER', `Refund of ${formatMoney(f.moneyMinor)} is over ${formatMoney(T.opsRefundMaxMinor)}.`)
    : null;

const P4: PolicyRule = (_input, f) =>
  f.movesMoney && f.moneyMinor > T.autoRefundMaxMinor && f.moneyMinor <= T.opsRefundMaxMinor
    ? fire('P4', 'OPS', `Refund of ${formatMoney(f.moneyMinor)} is over ${formatMoney(T.autoRefundMaxMinor)} and up to ${formatMoney(T.opsRefundMaxMinor)}.`)
    : null;

const P5: PolicyRule = (input, f) => {
  if (!f.movesMoney || f.moneyMinor > T.autoRefundMaxMinor || input.riskTier !== 'LOW') return null;
  if (f.isAgent && confidence(input) < T.autoRefundMinConfidence) return null;
  return fire('P5', 'AUTO', `Refund of ${formatMoney(f.moneyMinor)} is within ${formatMoney(T.autoRefundMaxMinor)} and risk is LOW.`);
};

const P6: PolicyRule = (input, f) => {
  if (!f.onlyStateCorrection || !input.gatewayCaptureVerified) return null;
  if (f.isAgent && confidence(input) < T.autoCorrectionMinConfidence) return null;
  return fire('P6', 'AUTO', 'State corrections only, and the gateway capture is verified.');
};

const P7: PolicyRule = (input) =>
  input.attempt >= 2 ? fire('P7', 'OPS', `This is attempt ${input.attempt} on the case, so a person reviews it.`) : null;

const P8: PolicyRule = (input, f) => {
  if (!f.isAgent) return null;
  if (input.diagnosisConfidence !== null && input.diagnosisConfidence >= T.lowConfidence) return null;
  return fire('P8', 'OPS', 'Agent diagnosis confidence is below 0.60.');
};

const P9: PolicyRule = (_input, f) =>
  f.hasClaim ? fire('P9', 'OPS', 'Raises a claim against a third party.') : null;

const P10: PolicyRule = (_input, f) =>
  f.onlyControl ? fire('P10', 'AUTO', 'Only holds or escalates; no money or records change.') : null;

/** Evaluation order is display order; the outcome does not depend on it (strictest tier wins). */
export const POLICY_RULE_TABLE: ReadonlyArray<{ id: PolicyRuleId; rule: PolicyRule }> = [
  { id: 'P0', rule: P0 },
  { id: 'P1', rule: P1 },
  { id: 'P2', rule: P2 },
  { id: 'P3', rule: P3 },
  { id: 'P4', rule: P4 },
  { id: 'P5', rule: P5 },
  { id: 'P6', rule: P6 },
  { id: 'P7', rule: P7 },
  { id: 'P8', rule: P8 },
  { id: 'P9', rule: P9 },
  { id: 'P10', rule: P10 },
  // P11 is the default: evaluatePolicy adds it when no other rule fired.
  { id: 'P11', rule: () => null },
];
