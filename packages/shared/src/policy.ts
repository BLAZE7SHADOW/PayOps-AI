/**
 * Policy vocabulary shared by core (evaluation) and web (display).
 * The evaluation itself is pure TypeScript in packages/core/src/policy; models never decide tiers.
 */
import type { Severity } from './enums';

export const POLICY_TIERS = ['AUTO', 'OPS', 'MANAGER', 'BLOCKED'] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];
export const POLICY_TIER_RANK: Record<PolicyTier, number> = { AUTO: 0, OPS: 1, MANAGER: 2, BLOCKED: 3 };

export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const satisfies readonly Severity[];
export type RiskTier = (typeof RISK_TIERS)[number];

export type ProposerType = 'USER' | 'AGENT';

export const POLICY_VERSION = '2026-09-28.1';

/** Money thresholds in paise (docs/03-agent-system.md §11). */
export const POLICY_THRESHOLDS = {
  autoRefundMaxMinor: 1_000_00,
  opsRefundMaxMinor: 10_000_00,
  autoRefundMinConfidence: 0.9,
  autoCorrectionMinConfidence: 0.85,
  lowConfidence: 0.6,
} as const;

export const POLICY_RULE_IDS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'] as const;
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

export interface PolicyRuleInfo {
  id: PolicyRuleId;
  condition: string;
  tier: PolicyTier | 'at least OPS';
  appliesTo: 'all' | 'agent';
}

/** Human-readable rule table, rendered on the Policy page. Must match core/policy/rules.ts. */
export const POLICY_RULES: readonly PolicyRuleInfo[] = [
  { id: 'P0', condition: 'Proposal is empty, relies on findings that failed grounding, or fails a precondition', tier: 'BLOCKED', appliesTo: 'all' },
  { id: 'P1', condition: 'Risk is CRITICAL and the proposal does anything other than hold or escalate', tier: 'BLOCKED', appliesTo: 'all' },
  { id: 'P2', condition: 'Risk is HIGH or CRITICAL', tier: 'MANAGER', appliesTo: 'all' },
  { id: 'P3', condition: 'Refunds over ₹10,000', tier: 'MANAGER', appliesTo: 'all' },
  { id: 'P4', condition: 'Refunds over ₹1,000 up to ₹10,000', tier: 'OPS', appliesTo: 'all' },
  { id: 'P5', condition: 'Refunds up to ₹1,000 with LOW risk (agent: confidence at least 0.90)', tier: 'AUTO', appliesTo: 'all' },
  { id: 'P6', condition: 'State corrections only, gateway capture verified (agent: confidence at least 0.85)', tier: 'AUTO', appliesTo: 'all' },
  { id: 'P7', condition: 'Second or later attempt on the same case', tier: 'at least OPS', appliesTo: 'all' },
  { id: 'P8', condition: 'Agent diagnosis confidence below 0.60', tier: 'at least OPS', appliesTo: 'agent' },
  { id: 'P9', condition: 'Claims against a third party (settlement disputes)', tier: 'OPS', appliesTo: 'all' },
  { id: 'P10', condition: 'Hold or escalate only', tier: 'AUTO', appliesTo: 'all' },
];

export interface PolicyReason {
  ruleId: PolicyRuleId;
  tier: PolicyTier;
  reason: string;
}

export interface PolicyDecision {
  tier: PolicyTier;
  /** Every rule that fired; the strictest tier wins. */
  reasons: PolicyReason[];
  version: string;
  /** Paise moved by the proposal (refunds). */
  moneyMovingMinor: number;
  riskTier: RiskTier;
}

/** Role needed to approve a tier. AUTO needs no approval; BLOCKED cannot be approved. */
export const APPROVER_ROLE: Record<Exclude<PolicyTier, 'AUTO' | 'BLOCKED'>, 'OPS' | 'MANAGER'> = {
  OPS: 'OPS',
  MANAGER: 'MANAGER',
};
