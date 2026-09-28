import { describe, expect, it } from 'vitest';
import { POLICY_RULES, POLICY_RULE_IDS, POLICY_VERSION, type CatalogAction, type PolicyTier } from '@payops/shared';
import { HOUR_MS, MINUTE_MS, attempt, gwPayment, healthySnapshot, withSnapshot } from '../reconciliation/test-factory';
import { approverHint, evaluatePolicy } from './evaluate';
import { POLICY_RULE_TABLE, type PolicyInput } from './rules';
import { riskTierFromRules } from './risk';

const replay: CatalogAction = { type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: 'evt_1' } };
const markPaid: CatalogAction = { type: 'MARK_ORDER_PAID', params: { orderId: 'ord_1', paymentId: 'pay_1' } };
const postLedger: CatalogAction = { type: 'POST_LEDGER_ENTRY', params: { paymentId: 'pay_1', amountMinor: 899_900 } };
const sync: CatalogAction = { type: 'SYNC_REFUND_STATUS', params: { refundId: 'rfd_1' } };
const refund = (amountMinor: number): CatalogAction => ({
  type: 'INITIATE_REFUND',
  params: { gwPaymentId: 'gwp_1', amountMinor, reason: 'Order cancelled' },
});
const dispute: CatalogAction = { type: 'RAISE_SETTLEMENT_DISPUTE', params: { batchId: 'stb_1', amountMinor: 13_924 } };
const hold: CatalogAction = { type: 'HOLD_PAYMENT_FOR_REVIEW', params: { paymentId: 'pay_1' } };
const escalate: CatalogAction = { type: 'ESCALATE_TO_HUMAN', params: { reason: 'Velocity pattern', to: 'MANAGER' } };

const base: PolicyInput = {
  proposer: 'USER',
  actions: [replay],
  riskTier: 'LOW',
  attempt: 1,
  diagnosisConfidence: null,
  groundingViolations: 0,
  preconditionFailures: 0,
  gatewayCaptureVerified: true,
};

interface Row {
  name: string;
  input: Partial<PolicyInput>;
  tier: PolicyTier;
  rules: string[];
}

const table: Row[] = [
  // Expected tiers for manual resolutions of the MVP scenarios.
  { name: 'captured_order_failed: replay', input: { actions: [replay] }, tier: 'AUTO', rules: ['P6'] },
  { name: 'refund_stuck: sync', input: { actions: [sync] }, tier: 'AUTO', rules: ['P6'] },
  { name: 'refund_never_initiated: ₹78,000 refund', input: { actions: [refund(7_800_000)] }, tier: 'MANAGER', rules: ['P3'] },
  { name: 'settlement_mismatch: dispute', input: { actions: [dispute] }, tier: 'OPS', rules: ['P9'] },
  { name: 'duplicate_capture: ₹4,999 refund', input: { actions: [refund(499_900)] }, tier: 'OPS', rules: ['P4'] },
  { name: 'suspicious_payment: hold + escalate, risk HIGH', input: { actions: [hold, escalate], riskTier: 'HIGH' }, tier: 'MANAGER', rules: ['P2', 'P10'] },
  { name: 'replay_fails attempt 2: mark paid + post ledger', input: { actions: [markPaid, postLedger], attempt: 2 }, tier: 'OPS', rules: ['P6', 'P7'] },
  // Money thresholds.
  { name: 'refund exactly ₹1,000 is AUTO', input: { actions: [refund(1_000_00)] }, tier: 'AUTO', rules: ['P5'] },
  { name: 'refund ₹1,000.01 is OPS', input: { actions: [refund(1_000_01)] }, tier: 'OPS', rules: ['P4'] },
  { name: 'refund exactly ₹10,000 is OPS', input: { actions: [refund(10_000_00)] }, tier: 'OPS', rules: ['P4'] },
  { name: 'refund ₹10,000.01 is MANAGER', input: { actions: [refund(10_000_01)] }, tier: 'MANAGER', rules: ['P3'] },
  { name: 'small refund with MEDIUM risk falls back to OPS', input: { actions: [refund(500_00)], riskTier: 'MEDIUM' }, tier: 'OPS', rules: ['P11'] },
  { name: 'two refunds are summed', input: { actions: [refund(6_000_00), refund(6_000_00)] }, tier: 'MANAGER', rules: ['P3'] },
  // Blocking.
  { name: 'CRITICAL risk + refund is BLOCKED', input: { actions: [refund(500_00)], riskTier: 'CRITICAL' }, tier: 'BLOCKED', rules: ['P1', 'P2'] },
  { name: 'CRITICAL risk + hold is MANAGER', input: { actions: [hold], riskTier: 'CRITICAL' }, tier: 'MANAGER', rules: ['P2', 'P10'] },
  { name: 'precondition failure is BLOCKED', input: { preconditionFailures: 1 }, tier: 'BLOCKED', rules: ['P0', 'P6'] },
  { name: 'empty proposal is BLOCKED', input: { actions: [] }, tier: 'BLOCKED', rules: ['P0'] },
  { name: 'grounding violation is BLOCKED', input: { groundingViolations: 2 }, tier: 'BLOCKED', rules: ['P0', 'P6'] },
  // Other rules.
  { name: 'state correction without verified capture needs OPS', input: { gatewayCaptureVerified: false }, tier: 'OPS', rules: ['P11'] },
  { name: 'hold alone is AUTO at LOW risk', input: { actions: [hold] }, tier: 'AUTO', rules: ['P10'] },
  { name: 'mixed control and correction has no auto rule', input: { actions: [markPaid, hold] }, tier: 'OPS', rules: ['P11'] },
  { name: 'attempt 3 raises AUTO to OPS', input: { attempt: 3 }, tier: 'OPS', rules: ['P6', 'P7'] },
  // Agent-only parts.
  { name: 'agent correction with 0.9 confidence is AUTO', input: { proposer: 'AGENT', diagnosisConfidence: 0.9 }, tier: 'AUTO', rules: ['P6'] },
  { name: 'agent correction with 0.8 confidence needs OPS', input: { proposer: 'AGENT', diagnosisConfidence: 0.8 }, tier: 'OPS', rules: ['P11'] },
  { name: 'agent with 0.5 confidence triggers P8', input: { proposer: 'AGENT', diagnosisConfidence: 0.5 }, tier: 'OPS', rules: ['P8'] },
  { name: 'agent small refund needs 0.9 for AUTO', input: { proposer: 'AGENT', actions: [refund(500_00)], diagnosisConfidence: 0.89 }, tier: 'OPS', rules: ['P11'] },
  { name: 'agent small refund at 0.95 is AUTO', input: { proposer: 'AGENT', actions: [refund(500_00)], diagnosisConfidence: 0.95 }, tier: 'AUTO', rules: ['P5'] },
  { name: 'P8 is skipped for people', input: { proposer: 'USER', diagnosisConfidence: 0.1 }, tier: 'AUTO', rules: ['P6'] },
];

describe('evaluatePolicy', () => {
  for (const row of table) {
    it(row.name, () => {
      const decision = evaluatePolicy({ ...base, ...row.input });
      expect(decision.tier).toBe(row.tier);
      expect(decision.reasons.map((r) => r.ruleId)).toEqual(row.rules);
      expect(decision.version).toBe(POLICY_VERSION);
    });
  }

  it('reports money moved and risk tier', () => {
    const decision = evaluatePolicy({ ...base, actions: [refund(7_800_000)], riskTier: 'MEDIUM' });
    expect(decision).toMatchObject({ moneyMovingMinor: 7_800_000, riskTier: 'MEDIUM' });
    expect(decision.reasons[0]?.reason).toBe('Refund of ₹78,000.00 is over ₹10,000.00.');
  });

  it('implements every rule in the shared rule table', () => {
    expect(POLICY_RULE_TABLE.map((r) => r.id)).toEqual([...POLICY_RULE_IDS]);
    expect(POLICY_RULES.map((r) => r.id)).toEqual([...POLICY_RULE_IDS]);
  });

  it('names who can approve', () => {
    expect(approverHint('OPS')).toBe('Another OPS user or a manager');
    expect(approverHint('MANAGER')).toBe('A manager');
    expect(approverHint('AUTO')).toBeNull();
  });
});

describe('riskTierFromRules', () => {
  const capturedAt = new Date('2026-09-28T11:50:00.000Z');
  const withFailures = (n: number, amountMinor: number) => {
    const s = healthySnapshot({ amountMinor });
    const gw = gwPayment({ amountMinor, capturedAt });
    return withSnapshot(s, {
      gateway: [gw],
      recentAttempts: Array.from({ length: n }, (_, i) => attempt({ at: new Date(capturedAt.getTime() - (i + 1) * 5 * MINUTE_MS) })),
    });
  };

  it('is HIGH at 5 failures before a capture of ₹10,000 or more', () => {
    expect(riskTierFromRules(withFailures(5, 10_000_00))).toBe('HIGH');
    expect(riskTierFromRules(withFailures(8, 45_000_00))).toBe('HIGH');
  });
  it('is MEDIUM at 3 failures, or 5 failures on a smaller capture', () => {
    expect(riskTierFromRules(withFailures(3, 45_000_00))).toBe('MEDIUM');
    expect(riskTierFromRules(withFailures(5, 9_999_99))).toBe('MEDIUM');
  });
  it('is LOW otherwise, and ignores failures outside the 24h window', () => {
    expect(riskTierFromRules(withFailures(2, 45_000_00))).toBe('LOW');
    const s = withFailures(0, 45_000_00);
    const old = Array.from({ length: 6 }, () => attempt({ at: new Date(capturedAt.getTime() - 25 * HOUR_MS) }));
    expect(riskTierFromRules({ ...s, recentAttempts: old })).toBe('LOW');
    expect(riskTierFromRules(null)).toBe('LOW');
  });
});
