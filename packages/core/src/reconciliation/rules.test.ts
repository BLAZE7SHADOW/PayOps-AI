import { describe, expect, it } from 'vitest';
import {
  d1CapturedNotPaid,
  d2PaidNotCaptured,
  d3LedgerMissing,
  d4DuplicateCapture,
  d5RefundPendingSla,
  d6RefundMissing,
  d8RiskVelocity,
  runOrderRules,
} from './rules';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  ago,
  attempt,
  captureJournal,
  capturedOrderFailedSnapshot,
  gwPayment,
  healthySnapshot,
  orderRow,
  paymentRow,
  refundRow,
  transition,
  withSnapshot,
} from './test-factory';

const cancelled = (cancelAgoMs: number) => {
  const base = healthySnapshot({ amountMinor: 7_800_000 });
  return withSnapshot(base, {
    order: orderRow({
      amountMinor: 7_800_000,
      status: 'CANCELLED',
      timeline: [...base.order.timeline, transition(ago(cancelAgoMs), 'PAID', 'CANCELLED', 'merchant')],
    }),
  });
};

const freshCapture = (capturedAgoMs: number) => {
  const base = capturedOrderFailedSnapshot();
  const gw = gwPayment({ capturedAt: ago(capturedAgoMs) });
  return withSnapshot(base, { gateway: [gw], order: orderRow({ status: 'PENDING', timeline: [] }) });
};

describe('healthy payment', () => {
  it('fires no rule', () => {
    expect(runOrderRules(healthySnapshot())).toEqual([]);
  });
});

describe('D1 captured, order not paid', () => {
  it('fires after the grace period', () => {
    const hit = d1CapturedNotPaid(capturedOrderFailedSnapshot());
    expect(hit).toMatchObject({ ruleId: 'D1_CAPTURED_NOT_PAID', caseType: 'PAYMENT_MISMATCH', amountMinor: 1_249_900, primaryEntity: { kind: 'payment', id: 'pay_1' } });
    expect(hit?.reason).toBe('Gateway captured ₹12,499.00 but the order is FAILED.');
  });
  it('waits 10 minutes before firing', () => {
    expect(d1CapturedNotPaid(freshCapture(9 * MINUTE_MS))).toBeNull();
    expect(d1CapturedNotPaid(freshCapture(11 * MINUTE_MS))).not.toBeNull();
  });
  it('does not fire for paid or cancelled orders', () => {
    expect(d1CapturedNotPaid(healthySnapshot())).toBeNull();
    expect(d1CapturedNotPaid(cancelled(3 * DAY_MS))).toBeNull();
  });
  it('does not fire once the gateway refunded everything', () => {
    const base = capturedOrderFailedSnapshot();
    const gw = gwPayment({ status: 'REFUNDED', refundedMinor: 1_249_900 });
    expect(d1CapturedNotPaid(withSnapshot(base, { gateway: [gw] }))).toBeNull();
  });
  it('keys on the gateway id when no internal payment exists', () => {
    const hit = d1CapturedNotPaid(withSnapshot(capturedOrderFailedSnapshot(), { payment: null }));
    expect(hit?.primaryEntity).toEqual({ kind: 'payment', id: 'gwp_1' });
  });
});

describe('D2 paid, not captured', () => {
  it('fires when the order is paid and nothing was captured', () => {
    const s = withSnapshot(healthySnapshot(), { gateway: [gwPayment({ status: 'FAILED', capturedAt: null })], ledger: [] });
    expect(d2PaidNotCaptured(s)).toMatchObject({ ruleId: 'D2_PAID_NOT_CAPTURED', severityFloor: 'HIGH', amountMinor: 1_249_900 });
  });
  it('does not fire for a captured payment', () => {
    expect(d2PaidNotCaptured(healthySnapshot())).toBeNull();
  });
  it('does not fire for an unpaid order', () => {
    const s = withSnapshot(healthySnapshot(), { order: orderRow({ status: 'PENDING' }), gateway: [gwPayment({ status: 'CREATED', capturedAt: null })] });
    expect(d2PaidNotCaptured(s)).toBeNull();
  });
});

describe('D3 ledger missing', () => {
  it('fires when a capture has no ledger credit', () => {
    expect(d3LedgerMissing(capturedOrderFailedSnapshot())).toMatchObject({ ruleId: 'D3_LEDGER_MISSING', severityFloor: 'MEDIUM', amountMinor: 1_249_900 });
  });
  it('fires for a partial credit with the missing amount', () => {
    const s = withSnapshot(healthySnapshot(), { ledger: captureJournal(1_000_000) });
    expect(d3LedgerMissing(s)?.amountMinor).toBe(249_900);
  });
  it('does not fire when the credit matches', () => {
    expect(d3LedgerMissing(healthySnapshot())).toBeNull();
  });
  it('waits 10 minutes before firing', () => {
    const s = withSnapshot(healthySnapshot(), { ledger: [], gateway: [gwPayment({ capturedAt: ago(5 * MINUTE_MS) })] });
    expect(d3LedgerMissing(s)).toBeNull();
  });
});

describe('D4 duplicate capture', () => {
  const dup = () => {
    const base = healthySnapshot({ amountMinor: 499_900 });
    return withSnapshot(base, { gateway: [...base.gateway, gwPayment({ id: 'gwp_2', amountMinor: 499_900, capturedAt: ago(26 * HOUR_MS - 2 * MINUTE_MS) })] });
  };
  it('fires on the order with the extra captured amount', () => {
    expect(d4DuplicateCapture(dup())).toMatchObject({
      ruleId: 'D4_DUPLICATE_CAPTURE',
      caseType: 'DUPLICATE',
      severityFloor: 'HIGH',
      primaryEntity: { kind: 'order', id: 'ord_1' },
      amountMinor: 499_900,
    });
  });
  it('does not fire for one capture plus a failed attempt', () => {
    const base = healthySnapshot();
    const s = withSnapshot(base, { gateway: [...base.gateway, gwPayment({ id: 'gwp_2', status: 'FAILED', capturedAt: null })] });
    expect(d4DuplicateCapture(s)).toBeNull();
  });
  it('fires on nothing else for a duplicate on a paid order', () => {
    expect(runOrderRules(dup()).map((h) => h.ruleId)).toEqual(['D4_DUPLICATE_CAPTURE']);
  });
});

describe('D5 refund pending beyond SLA', () => {
  it('fires for a refund pending more than 7 days', () => {
    const s = withSnapshot(healthySnapshot(), { refunds: [refundRow({ requestedAt: ago(9 * DAY_MS) })] });
    const hit = d5RefundPendingSla(s);
    expect(hit).toMatchObject({ ruleId: 'D5_REFUND_PENDING_SLA', caseType: 'REFUND_EXCEPTION', severityFloor: 'MEDIUM', amountMinor: 345_000 });
    expect(hit?.reason).toBe('Refund of ₹3,450.00 has been PENDING for 9 days.');
  });
  it('does not fire inside the SLA or once processed', () => {
    expect(d5RefundPendingSla(withSnapshot(healthySnapshot(), { refunds: [refundRow({ requestedAt: ago(6 * DAY_MS) })] }))).toBeNull();
    expect(d5RefundPendingSla(withSnapshot(healthySnapshot(), { refunds: [refundRow({ status: 'PROCESSED' })] }))).toBeNull();
  });
});

describe('D6 refund missing on a cancelled order', () => {
  it('fires 48 hours after cancellation', () => {
    expect(d6RefundMissing(cancelled(3 * DAY_MS))).toMatchObject({
      ruleId: 'D6_REFUND_MISSING',
      caseType: 'REFUND_EXCEPTION',
      amountMinor: 7_800_000,
      primaryEntity: { kind: 'payment', id: 'pay_1' },
    });
  });
  it('does not fire within 48 hours', () => {
    expect(d6RefundMissing(cancelled(47 * HOUR_MS))).toBeNull();
  });
  it('does not fire when an internal refund exists', () => {
    expect(d6RefundMissing(withSnapshot(cancelled(3 * DAY_MS), { refunds: [refundRow({ amountMinor: 7_800_000 })] }))).toBeNull();
  });
  it('does not fire when the gateway refunded in full', () => {
    const gw = gwPayment({ amountMinor: 7_800_000, status: 'REFUNDED', refundedMinor: 7_800_000 });
    expect(d6RefundMissing(withSnapshot(cancelled(3 * DAY_MS), { gateway: [gw] }))).toBeNull();
  });
  it('does not fire for an order that is not cancelled', () => {
    expect(d6RefundMissing(healthySnapshot())).toBeNull();
  });
});

describe('D8 risk velocity', () => {
  const risky = (failedCount: number, amountMinor = 4_500_000) => {
    const base = healthySnapshot({ amountMinor });
    const capturedAt = base.primaryGw!.capturedAt!;
    const countries = ['IN', 'US', 'NG'];
    const failed = Array.from({ length: failedCount }, (_, i) =>
      attempt({ at: new Date(capturedAt.getTime() - (60 - i * 6) * MINUTE_MS), cardCountry: countries[i % 3] ?? 'IN' }),
    );
    return withSnapshot(base, { recentAttempts: failed });
  };
  it('fires for 5+ failures before a large capture', () => {
    const hit = d8RiskVelocity(risky(8));
    expect(hit).toMatchObject({ ruleId: 'D8_RISK_VELOCITY', caseType: 'RISK_CASE', severityFloor: 'HIGH', amountMinor: 4_500_000 });
    expect(hit?.reason).toBe('8 failed attempts across 3 card countries in 24h before a ₹45,000.00 capture.');
  });
  it('does not fire for 4 failures', () => {
    expect(d8RiskVelocity(risky(4))).toBeNull();
  });
  it('does not fire under ₹10,000', () => {
    expect(d8RiskVelocity(risky(8, 999_900))).toBeNull();
  });
  it('ignores failures older than 24 hours or after the capture', () => {
    const base = risky(0);
    const capturedAt = base.primaryGw!.capturedAt!.getTime();
    const outside = [
      ...Array.from({ length: 3 }, () => attempt({ at: new Date(capturedAt - 25 * HOUR_MS) })),
      ...Array.from({ length: 3 }, () => attempt({ at: new Date(capturedAt + MINUTE_MS) })),
    ];
    expect(d8RiskVelocity(withSnapshot(base, { recentAttempts: outside }))).toBeNull();
  });
});

describe('captured / order failed', () => {
  it('fires D1 and D3 on the same payment', () => {
    expect(runOrderRules(capturedOrderFailedSnapshot()).map((h) => h.ruleId)).toEqual(['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING']);
  });
  it('keys on the order when neither payment record exists', () => {
    const s = withSnapshot(healthySnapshot(), { gateway: [], payment: null, ledger: [] });
    expect(d2PaidNotCaptured(s)?.primaryEntity).toEqual({ kind: 'order', id: 'ord_1' });
  });
  it('uses the internal payment status only for display', () => {
    expect(runOrderRules(withSnapshot(healthySnapshot(), { payment: paymentRow({ status: 'PENDING' }) }))).toEqual([]);
  });
});
