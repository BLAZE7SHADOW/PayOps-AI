import { describe, expect, it } from 'vitest';
import { buildMatrix } from './matrix';
import {
  DAY_MS,
  HOUR_MS,
  ago,
  captureJournal,
  capturedOrderFailedSnapshot,
  delivery,
  gwPayment,
  gwRefund,
  healthySnapshot,
  ledgerLeg,
  orderRow,
  paymentRow,
  refundRow,
  settlementLine,
  transition,
  withSnapshot,
} from './test-factory';

describe('buildMatrix', () => {
  it('shows a healthy payment with no mismatches', () => {
    const m = buildMatrix(healthySnapshot());
    expect(m.mismatched).toEqual([]);
    expect(m.cells.GATEWAY).toMatchObject({ status: 'CAPTURED', amountMinor: 1_249_900, reference: true, mismatch: false });
    expect(m.cells.ORDER).toMatchObject({ status: 'PAID', detail: 'Internal payment CAPTURED', reference: false });
    expect(m.cells.LEDGER).toMatchObject({ status: 'POSTED', amountMinor: 1_249_900 });
    expect(m.cells.WEBHOOK).toMatchObject({ status: 'DELIVERED', detail: 'payment.captured' });
    expect(m.cells.SETTLEMENT).toMatchObject({ status: 'SETTLED', detail: 'Batch stb_1' });
    expect(m.cells.SETTLEMENT.amountMinor).toBe(1_249_900 - 24_998 - 4_500);
  });

  it('flags order, ledger and webhook for captured / order failed', () => {
    const m = buildMatrix(capturedOrderFailedSnapshot());
    expect(m.mismatched).toEqual(['ORDER', 'LEDGER', 'WEBHOOK']);
    expect(m.cells.ORDER).toMatchObject({ status: 'FAILED', detail: 'Internal payment PENDING' });
    expect(m.cells.LEDGER).toMatchObject({ status: 'MISSING', amountMinor: null, detail: 'No capture credit for ₹12,499.00' });
    expect(m.cells.WEBHOOK).toMatchObject({ status: 'HTTP 500 ×3', detail: 'payment.captured' });
    expect(m.cells.WEBHOOK.at).toBe(capturedOrderFailedSnapshot().webhooks[0]?.attempts[2]?.at);
    expect(m.cells.SETTLEMENT.status).toBe('SETTLED');
  });

  it('marks a duplicate capture on the gateway cell', () => {
    const base = healthySnapshot({ amountMinor: 499_900 });
    const second = gwPayment({ id: 'gwp_2', amountMinor: 499_900, capturedAt: ago(26 * HOUR_MS - 120_000) });
    const m = buildMatrix(withSnapshot(base, { gateway: [...base.gateway, second] }));
    expect(m.cells.GATEWAY).toMatchObject({ status: 'CAPTURED ×2', amountMinor: 999_800, mismatch: true, detail: '2 captures on one order' });
    expect(m.mismatched).toEqual(['GATEWAY']);
  });

  it('flags an order marked paid with nothing captured', () => {
    const base = healthySnapshot();
    const m = buildMatrix(withSnapshot(base, { gateway: [gwPayment({ status: 'FAILED', capturedAt: null })], ledger: [], settlementLines: [] }));
    expect(m.cells.ORDER.mismatch).toBe(true);
    expect(m.cells.LEDGER.status).toBe('NOT EXPECTED');
    expect(m.cells.SETTLEMENT.status).toBe('NOT EXPECTED');
  });

  it('flags a cancelled order that still holds captured money', () => {
    const base = healthySnapshot();
    const order = orderRow({ status: 'CANCELLED', timeline: [...base.order.timeline, transition(ago(3 * DAY_MS), 'PAID', 'CANCELLED', 'merchant')] });
    expect(buildMatrix(withSnapshot(base, { order })).cells.ORDER.mismatch).toBe(true);
  });

  it('accepts a cancelled order once the gateway refunded it in full', () => {
    const base = healthySnapshot({ amountMinor: 345_000 });
    const order = orderRow({ amountMinor: 345_000, status: 'CANCELLED' });
    const gw = gwPayment({ amountMinor: 345_000, status: 'REFUNDED', refundedMinor: 345_000 });
    const m = buildMatrix(withSnapshot(base, { order, gateway: [gw], gwRefunds: [gwRefund()], refunds: [refundRow()] }));
    expect(m.cells.ORDER.mismatch).toBe(false);
    expect(m.cells.GATEWAY.detail).toBe('Refund ₹3,450.00 PROCESSED');
    expect(m.cells.LEDGER).toMatchObject({ status: 'REFUND MISSING', mismatch: true });
  });

  it('shows a failed refund webhook with its event name', () => {
    const base = healthySnapshot();
    const refundHook = delivery({ id: 'evt_2', event: 'refund.processed', fail: true, gwRefundId: 'gwr_1' });
    const m = buildMatrix(withSnapshot(base, { webhooks: [...base.webhooks, refundHook] }));
    expect(m.cells.WEBHOOK).toMatchObject({ status: 'HTTP 500 ×3', detail: 'refund.processed', mismatch: true });
  });

  it('reports a timeout when the last attempt had no response', () => {
    const hook = delivery({
      finalStatus: 'FAILED',
      attempts: [{ at: ago(HOUR_MS).toISOString(), httpStatus: null, latencyMs: 30_000, error: 'timeout' }],
    });
    expect(buildMatrix(withSnapshot(healthySnapshot(), { webhooks: [hook] })).cells.WEBHOOK.status).toBe('TIMEOUT ×1');
  });

  it('shows pending and missing webhooks without a mismatch', () => {
    const pending = buildMatrix(withSnapshot(healthySnapshot(), { webhooks: [delivery({ finalStatus: 'PENDING' })] }));
    expect(pending.cells.WEBHOOK).toMatchObject({ status: 'PENDING', mismatch: false });
    const none = buildMatrix(withSnapshot(healthySnapshot(), { webhooks: [] }));
    expect(none.cells.WEBHOOK).toMatchObject({ status: 'NONE', mismatch: false });
  });

  it('marks a partial ledger credit', () => {
    const m = buildMatrix(withSnapshot(healthySnapshot(), { ledger: captureJournal(1_000_000) }));
    expect(m.cells.LEDGER).toMatchObject({ status: 'PARTIAL', mismatch: true, amountMinor: 1_000_000 });
  });

  it('marks ledger entries without any capture as partial', () => {
    const base = healthySnapshot();
    const m = buildMatrix(withSnapshot(base, { gateway: [gwPayment({ status: 'FAILED', capturedAt: null })], settlementLines: [] }));
    expect(m.cells.LEDGER).toMatchObject({ status: 'PARTIAL', mismatch: true });
  });

  it('shows a fee mismatch on the settlement cell', () => {
    const base = healthySnapshot({ amountMinor: 1_180_000 });
    const line = settlementLine(base.gateway[0]!, base.merchant, { feeBps: 300 });
    const m = buildMatrix(withSnapshot(base, { settlementLines: [line] }));
    expect(m.cells.SETTLEMENT).toMatchObject({ status: 'FEE MISMATCH', mismatch: true, detail: 'Fee ₹417.72 vs contract ₹278.48' });
    expect(m.mismatched).toEqual(['SETTLEMENT']);
  });

  it('shows settlement pending when captured but not yet settled', () => {
    const m = buildMatrix(withSnapshot(healthySnapshot(), { settlementLines: [], settlement: null }));
    expect(m.cells.SETTLEMENT).toMatchObject({ status: 'PENDING', mismatch: false });
  });

  it('handles an order with no gateway payment at all', () => {
    const base = healthySnapshot();
    const m = buildMatrix(withSnapshot(base, { gateway: [], payment: paymentRow({ status: 'PENDING' }), ledger: [], settlementLines: [], webhooks: [] }));
    expect(m.cells.GATEWAY).toMatchObject({ status: null, reference: true });
    expect(m.cells.ORDER.mismatch).toBe(true);
    expect(m.cells.LEDGER.status).toBe('NOT EXPECTED');
  });

  it('ignores a refund posting when checking capture credit', () => {
    const base = healthySnapshot();
    const ledger = [...base.ledger, ledgerLeg({ id: 'led_r', refundId: 'rfd_1', direction: 'DEBIT', amountMinor: 1_000 })];
    expect(buildMatrix(withSnapshot(base, { ledger })).cells.LEDGER.status).toBe('POSTED');
  });
});
