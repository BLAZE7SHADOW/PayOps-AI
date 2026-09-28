import { describe, expect, it } from 'vitest';
import { evaluateOrder, groupHits, maxSeverity, priorityOf, snapshotEntityRefs } from './candidates';
import { buildMatrix } from './matrix';
import type { RuleHit } from './rules';
import { HOUR_MS, ago, capturedOrderFailedSnapshot, gwPayment, healthySnapshot, withSnapshot } from './test-factory';

const hit = (o: Partial<RuleHit>): RuleHit => ({
  ruleId: 'D1_CAPTURED_NOT_PAID',
  caseType: 'PAYMENT_MISMATCH',
  primaryEntity: { kind: 'payment', id: 'pay_1' },
  amountMinor: 100_000,
  reason: 'test',
  ...o,
});

const ctx = { entityRefs: { orderId: 'ord_1' }, matrix: buildMatrix(healthySnapshot()) };

describe('groupHits', () => {
  it('merges hits with the same case type and entity into one candidate', () => {
    const out = groupHits(
      [hit({ ruleId: 'D3_LEDGER_MISSING', severityFloor: 'MEDIUM', amountMinor: 50_000 }), hit({ ruleId: 'D1_CAPTURED_NOT_PAID' }), hit({ ruleId: 'D1_CAPTURED_NOT_PAID' })],
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      fingerprint: 'PAYMENT_MISMATCH:pay_1',
      type: 'PAYMENT_MISMATCH',
      ruleIds: ['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING'],
      amountMinor: 100_000,
      severity: 'MEDIUM',
    });
  });

  it('keeps different case types or entities apart', () => {
    const out = groupHits(
      [hit({}), hit({ caseType: 'RISK_CASE', ruleId: 'D8_RISK_VELOCITY' }), hit({ primaryEntity: { kind: 'payment', id: 'pay_2' } })],
      ctx,
    );
    expect(out.map((c) => c.fingerprint)).toEqual(['PAYMENT_MISMATCH:pay_1', 'RISK_CASE:pay_1', 'PAYMENT_MISMATCH:pay_2']);
  });

  it('uses the higher of amount band and rule floor', () => {
    expect(groupHits([hit({ amountMinor: 99_900 })], ctx)[0]?.severity).toBe('LOW');
    expect(groupHits([hit({ amountMinor: 99_900, severityFloor: 'HIGH' })], ctx)[0]?.severity).toBe('HIGH');
    expect(groupHits([hit({ amountMinor: 7_800_000, severityFloor: 'MEDIUM' })], ctx)[0]?.severity).toBe('CRITICAL');
  });

  it('records the batch id for batch cases', () => {
    const out = groupHits([hit({ caseType: 'SETTLEMENT_MISMATCH', ruleId: 'D7_SETTLEMENT_DIFF', primaryEntity: { kind: 'batch', id: 'stb_9' } })], ctx);
    expect(out[0]?.entityRefs).toEqual({ orderId: 'ord_1', batchId: 'stb_9' });
  });
});

describe('priority and severity', () => {
  it('orders by severity first, then rupees', () => {
    expect(priorityOf('HIGH', 1_249_900)).toBe(2_012_499);
    expect(priorityOf('CRITICAL', 1)).toBeGreaterThan(priorityOf('HIGH', 100_000_000_000));
    expect(priorityOf('LOW', 100_000_000_000)).toBe(999_999);
  });
  it('picks the maximum severity', () => {
    expect(maxSeverity('LOW', undefined, 'HIGH', 'MEDIUM')).toBe('HIGH');
    expect(maxSeverity()).toBe('LOW');
  });
});

describe('evaluateOrder', () => {
  it('produces one payment mismatch case for captured / order failed', () => {
    const r = evaluateOrder(capturedOrderFailedSnapshot());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      fingerprint: 'PAYMENT_MISMATCH:pay_1',
      ruleIds: ['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING'],
      severity: 'HIGH',
      entityRefs: { paymentId: 'pay_1', gwPaymentId: 'gwp_1', orderId: 'ord_1', customerId: 'cus_1', merchantId: 'mer_1', batchId: 'stb_1' },
    });
    expect(r.candidates[0]?.matrix.mismatched).toEqual(['ORDER', 'LEDGER', 'WEBHOOK']);
  });

  it('produces nothing for a healthy payment', () => {
    expect(evaluateOrder(healthySnapshot()).candidates).toEqual([]);
  });

  it('lists the extra gateway payments of a duplicate', () => {
    const base = healthySnapshot();
    const s = withSnapshot(base, { gateway: [...base.gateway, gwPayment({ id: 'gwp_2', capturedAt: ago(25 * HOUR_MS) })] });
    expect(snapshotEntityRefs(s).duplicateGwPaymentIds).toEqual(['gwp_2']);
  });
});
