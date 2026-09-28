import { describe, expect, it } from 'vitest';
import {
  captureCreditMinor,
  capturedGw,
  capturedTotalMinor,
  expectedFee,
  lastTransitionAt,
  outstandingCapturedMinor,
  refundPostedMinor,
} from './facts';
import { captureJournal, gwPayment, healthySnapshot, ledgerLeg, merchantRow, orderRow, transition, ago, HOUR_MS } from './test-factory';

describe('facts', () => {
  it('counts refunded payments as captured once', () => {
    const s = { gateway: [gwPayment({ status: 'REFUNDED', refundedMinor: 1_249_900 }), gwPayment({ id: 'gwp_2', status: 'FAILED' })] };
    expect(capturedGw(s).map((g) => g.id)).toEqual(['gwp_1']);
    expect(capturedTotalMinor(s)).toBe(1_249_900);
    expect(outstandingCapturedMinor(s)).toBe(0);
  });

  it('nets capture credits and ignores refund postings', () => {
    const ledger = [
      ...captureJournal(10_000),
      ledgerLeg({ id: 'led_r', refundId: 'rfd_1', direction: 'DEBIT', amountMinor: 4_000 }),
      ledgerLeg({ id: 'led_rev', direction: 'DEBIT', amountMinor: 1_000, reversalOf: 'led_c2' }),
    ];
    expect(captureCreditMinor({ ledger })).toBe(9_000);
    expect(refundPostedMinor({ ledger })).toBe(4_000);
  });

  it('computes the contract fee in integer paise', () => {
    // ₹11,800 at 2% = ₹236 fee, 18% GST = ₹42.48, net ₹11,521.52
    expect(expectedFee(1_180_000, merchantRow())).toEqual({ feeMinor: 23_600, taxMinor: 4_248, netMinor: 1_152_152 });
    expect(expectedFee(10_000, merchantRow({ feeFixedMinor: 300 }))).toEqual({ feeMinor: 500, taxMinor: 90, netMinor: 9_410 });
  });

  it('finds the latest transition into a status', () => {
    const order = orderRow({
      timeline: [transition(ago(5 * HOUR_MS), null, 'PENDING', 'checkout'), transition(ago(4 * HOUR_MS), 'PENDING', 'CANCELLED', 'merchant')],
    });
    expect(lastTransitionAt(order, 'CANCELLED')?.toISOString()).toBe(ago(4 * HOUR_MS).toISOString());
    expect(lastTransitionAt(order, 'PAID')).toBeNull();
    expect(lastTransitionAt(healthySnapshot().order, 'PAID')).not.toBeNull();
  });
});
