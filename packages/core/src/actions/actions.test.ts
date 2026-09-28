import { describe, expect, it } from 'vitest';
import type { CatalogAction } from '@payops/shared';
import type { CaseRow } from '../db/rows';
import {
  DAY_MS,
  NOW,
  ago,
  captureJournal,
  capturedOrderFailedSnapshot,
  delivery,
  gwPayment,
  gwRefund,
  healthySnapshot,
  merchantRow,
  paymentRow,
  refundRow,
  settlementLine,
  settlementRow,
  withSnapshot,
} from '../reconciliation/test-factory';
import { buildMatrix } from '../reconciliation/matrix';
import { checkBatch } from '../reconciliation/settlement';
import type { OrderSnapshot } from '../reconciliation/snapshot';
import type { BatchData } from '../services/snapshot.loader';
import { refundableMinor } from './facts';
import { idempotencyKey, stableJson } from './idempotency';
import { actionOptions } from './options';
import { postconditionsOf, preconditionsOf } from './registry';
import type { CaseState } from './types';

function caseRow(o: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'case_1',
    displayId: 'PAY-0001',
    fingerprint: 'PAYMENT_MISMATCH:pay_1',
    type: 'PAYMENT_MISMATCH',
    severity: 'HIGH',
    priority: 1,
    status: 'OPEN',
    amountMinor: 1_249_900,
    ruleIds: ['D1_CAPTURED_NOT_PAID'],
    matrix: buildMatrix(healthySnapshot()).cells,
    mismatched: [],
    entityRefs: { orderId: 'ord_1', paymentId: 'pay_1', gwPaymentId: 'gwp_1' },
    signals: {},
    assigneeId: null,
    activeRunId: null,
    resolution: null,
    lastDetectedAt: NOW,
    openedAt: NOW,
    resolvedAt: null,
    updatedAt: NOW,
    ...o,
  };
}

const state = (order: OrderSnapshot | null, o: Partial<CaseState> = {}): CaseState => ({ now: NOW, case: caseRow(), order, batch: null, ...o });
const pre = (a: CatalogAction, s: CaseState) => preconditionsOf(a, s);
const post = (a: CatalogAction, s: CaseState) => postconditionsOf(a, s, 0).map((c) => [c.id, c.pass]);

describe('REPLAY_WEBHOOK_EVENT', () => {
  const a: CatalogAction = { type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: 'evt_1' } };
  it('needs an undelivered event of this case', () => {
    expect(pre(a, state(capturedOrderFailedSnapshot()))).toEqual([]);
    expect(pre(a, state(healthySnapshot()))).toEqual(['Event evt_1 (payment.captured) was already delivered.']);
    expect(pre({ ...a, params: { eventId: 'evt_other' } }, state(capturedOrderFailedSnapshot()))[0]).toMatch(/does not belong/);
    expect(pre(a, state(null))).toHaveLength(1);
  });
  it('passes only when delivered and the payment mirrors the gateway', () => {
    expect(post(a, state(capturedOrderFailedSnapshot()))).toEqual([
      ['a0.webhook.delivery', false],
      ['a0.payment.status', false],
    ]);
    expect(post(a, state(healthySnapshot()))).toEqual([
      ['a0.webhook.delivery', true],
      ['a0.payment.status', true],
    ]);
  });
});

describe('MARK_ORDER_PAID', () => {
  const a: CatalogAction = { type: 'MARK_ORDER_PAID', params: { orderId: 'ord_1', paymentId: 'pay_1' } };
  it('needs a gateway capture and an unpaid order', () => {
    expect(pre(a, state(capturedOrderFailedSnapshot()))).toEqual([]);
    expect(pre(a, state(healthySnapshot()))).toEqual(['Order ord_1 is already PAID.']);
    const failedGw = withSnapshot(capturedOrderFailedSnapshot(), { gateway: [gwPayment({ status: 'FAILED', capturedAt: null })] });
    expect(pre(a, state(failedGw))).toEqual(['The gateway shows gwp_1 as FAILED, not CAPTURED.']);
  });
  it('checks status and link', () => {
    expect(post(a, state(healthySnapshot()))).toEqual([
      ['a0.order.status', true],
      ['a0.order.paymentId', true],
    ]);
    expect(post(a, state(capturedOrderFailedSnapshot()))[0]).toEqual(['a0.order.status', false]);
  });
});

describe('POST_LEDGER_ENTRY', () => {
  const a: CatalogAction = { type: 'POST_LEDGER_ENTRY', params: { paymentId: 'pay_1', amountMinor: 1_249_900 } };
  it('refuses a second capture credit and a wrong amount', () => {
    expect(pre(a, state(capturedOrderFailedSnapshot()))).toEqual([]);
    expect(pre(a, state(healthySnapshot()))).toEqual(['A capture credit of ₹12,499.00 is already posted for pay_1.']);
    expect(pre({ ...a, params: { paymentId: 'pay_1', amountMinor: 100 } }, state(capturedOrderFailedSnapshot()))[0]).toMatch(/does not match the gateway capture/);
  });
  it('wants exactly one capture journal of the amount', () => {
    expect(post(a, state(healthySnapshot()))).toEqual([['a0.ledger.captureCredit', true]]);
    expect(post(a, state(capturedOrderFailedSnapshot()))).toEqual([['a0.ledger.captureCredit', false]]);
    const twice = withSnapshot(healthySnapshot(), {
      ledger: [...captureJournal(1_249_900), ...captureJournal(1_249_900, { journalId: 'jrn_2' }).map((l, i) => ({ ...l, id: `led_d${i}` }))],
    });
    expect(post(a, state(twice))).toEqual([['a0.ledger.captureCredit', false]]);
  });
});

describe('REVERSE_LEDGER_ENTRY', () => {
  const a: CatalogAction = { type: 'REVERSE_LEDGER_ENTRY', params: { journalId: 'jrn_1' } };
  it('needs an unreversed journal of this case', () => {
    expect(pre(a, state(healthySnapshot()))).toEqual([]);
    const reversed = withSnapshot(healthySnapshot(), {
      ledger: [...captureJournal(1_249_900), ...captureJournal(1_249_900, { journalId: 'jrn_r' }).map((l, i) => ({ ...l, id: `led_r${i}`, reversalOf: i === 0 ? 'led_c1' : 'led_c2', direction: l.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const) }))],
    });
    expect(pre(a, state(reversed))).toEqual(['Journal jrn_1 was already reversed by jrn_r.']);
    expect(pre({ type: 'REVERSE_LEDGER_ENTRY', params: { journalId: 'jrn_zzz' } }, state(healthySnapshot()))[0]).toMatch(/not on this case/);
  });
});

describe('INITIATE_REFUND', () => {
  const refund = (amountMinor: number): CatalogAction => ({ type: 'INITIATE_REFUND', params: { gwPaymentId: 'gwp_1', amountMinor, reason: 'Order cancelled' } });
  it('caps the amount at the refundable balance, counting pending refunds', () => {
    const s = healthySnapshot();
    expect(refundableMinor(s, 'gwp_1')).toBe(1_249_900);
    expect(pre(refund(1_249_900), state(s))).toEqual([]);
    expect(pre(refund(1_249_901), state(s))[0]).toMatch(/more than the refundable balance of ₹12,499.00/);
    const pending = withSnapshot(s, { gwRefunds: [gwRefund({ amountMinor: 200_000, status: 'PENDING', processedAt: null })] });
    expect(refundableMinor(pending, 'gwp_1')).toBe(1_049_900);
    const unsent = withSnapshot(s, { refunds: [refundRow({ amountMinor: 49_900, status: 'REQUESTED', gwRefundId: null })] });
    expect(refundableMinor(unsent, 'gwp_1')).toBe(1_200_000);
  });
  it('refuses payments that are not captured or not on this order', () => {
    const refunded = withSnapshot(healthySnapshot(), { gateway: [gwPayment({ status: 'REFUNDED', refundedMinor: 1_249_900 })] });
    expect(pre(refund(100), state(refunded))[0]).toMatch(/is REFUNDED/);
    expect(pre({ type: 'INITIATE_REFUND', params: { gwPaymentId: 'gwp_x', amountMinor: 100, reason: 'x y z' } }, state(healthySnapshot()))[0]).toMatch(/does not belong/);
  });
  it('checks the gateway refund and our mirror', () => {
    const after = withSnapshot(healthySnapshot(), {
      gateway: [gwPayment({ status: 'PARTIALLY_REFUNDED', refundedMinor: 500_000 })],
      gwRefunds: [gwRefund({ amountMinor: 500_000 })],
      refunds: [refundRow({ amountMinor: 500_000, gwRefundId: 'gwr_1', status: 'PROCESSED', reason: 'Order cancelled' })],
    });
    expect(post(refund(500_000), state(after))).toEqual([
      ['a0.refund.gateway', true],
      ['a0.refund.internal', true],
      ['a0.refund.balance', true],
    ]);
    expect(post(refund(500_000), state(healthySnapshot())).map(([, p]) => p)).toEqual([false, false, true]);
  });
});

describe('SYNC_REFUND_STATUS', () => {
  const a: CatalogAction = { type: 'SYNC_REFUND_STATUS', params: { refundId: 'rfd_1' } };
  const stuck = withSnapshot(healthySnapshot(), { refunds: [refundRow({ gwRefundId: 'gwr_1' })], gwRefunds: [gwRefund()] });
  it('needs a linked refund whose gateway status is final', () => {
    expect(pre(a, state(stuck))).toEqual([]);
    expect(pre(a, state(withSnapshot(stuck, { gwRefunds: [gwRefund({ status: 'PENDING', processedAt: null })] })))).toEqual(['The gateway still shows refund gwr_1 as PENDING.']);
    expect(pre(a, state(withSnapshot(stuck, { refunds: [refundRow({ gwRefundId: null })] })))[0]).toMatch(/never sent to the gateway/);
    expect(pre(a, state(withSnapshot(stuck, { refunds: [refundRow({ gwRefundId: 'gwr_1', status: 'PROCESSED' })] })))).toEqual(['Refund rfd_1 is already PROCESSED.']);
  });
  it('checks status and the refund journal', () => {
    expect(post(a, state(stuck))).toEqual([
      ['a0.refund.status', false],
      ['a0.ledger.refundJournal', false],
    ]);
    const synced = withSnapshot(stuck, {
      refunds: [refundRow({ gwRefundId: 'gwr_1', status: 'PROCESSED' })],
      ledger: [...captureJournal(1_249_900), ...captureJournal(345_000, { journalId: 'jrn_rf', refundId: 'rfd_1' }).map((l, i) => ({ ...l, id: `led_rf${i}` }))],
    });
    expect(post(a, state(synced))).toEqual([
      ['a0.refund.status', true],
      ['a0.ledger.refundJournal', true],
    ]);
  });
});

describe('RAISE_SETTLEMENT_DISPUTE and D7 suppression', () => {
  const merchant = merchantRow();
  const gw = gwPayment();
  const lines = [settlementLine(gw, merchant, { feeBps: 300 })];
  const batch = (disputes: BatchData['disputes'] = []): CaseState['batch'] => {
    const data: BatchData = { settlement: settlementRow({ status: 'MISMATCH' }), lines, merchant, paymentsByGw: new Map(), disputes };
    return { data, check: checkBatch(data) };
  };
  const diff = Math.abs(batch()!.check.diffMinor);
  const a: CatalogAction = { type: 'RAISE_SETTLEMENT_DISPUTE', params: { batchId: 'stb_1', amountMinor: diff, gwPaymentId: 'gwp_1' } };
  const dispute = (o: Partial<BatchData['disputes'][number]> = {}) => ({
    id: 'dsp_1', type: 'SETTLEMENT' as const, batchId: 'stb_1', gwPaymentId: 'gwp_1', amountMinor: diff, status: 'OPEN' as const, reason: 'short', resolutionId: null, createdAt: NOW, updatedAt: NOW, ...o,
  });

  it('needs a mismatched batch, the exact diff, and no open dispute', () => {
    expect(pre(a, state(null, { batch: batch() }))).toEqual([]);
    expect(pre({ ...a, params: { ...a.params, amountMinor: diff + 1 } }, state(null, { batch: batch() }))[0]).toMatch(/does not match the batch difference/);
    expect(pre(a, state(null, { batch: batch([dispute()]) }))).toEqual(['Batch stb_1 already has an open dispute (dsp_1).']);
    expect(pre(a, state(null))[0]).toMatch(/not this case's settlement batch/);
  });

  it('D7 is suppressed only by an OPEN dispute covering exactly the diff', () => {
    expect(batch()!.check.hit?.ruleId).toBe('D7_SETTLEMENT_DIFF');
    expect(batch([dispute()])!.check).toMatchObject({ hit: null, disputeId: 'dsp_1' });
    expect(batch([dispute({ amountMinor: diff - 1 })])!.check.hit).not.toBeNull();
    expect(batch([dispute({ status: 'LOST' })])!.check.hit).not.toBeNull();
    expect(post(a, state(null, { batch: batch([dispute()]) }))).toEqual([['a0.dispute.open', true]]);
  });
});

describe('HOLD_PAYMENT_FOR_REVIEW and ESCALATE_TO_HUMAN', () => {
  it('hold needs the case payment, not already held', () => {
    const a: CatalogAction = { type: 'HOLD_PAYMENT_FOR_REVIEW', params: { paymentId: 'pay_1' } };
    expect(pre(a, state(healthySnapshot()))).toEqual([]);
    const held = withSnapshot(healthySnapshot(), { payment: paymentRow({ hold: true }) });
    expect(pre(a, state(held))).toEqual(['Payment pay_1 is already on hold.']);
    expect(post(a, state(held))).toEqual([['a0.payment.hold', true]]);
  });
  it('escalate is always allowed and checks the case status', () => {
    const a: CatalogAction = { type: 'ESCALATE_TO_HUMAN', params: { reason: 'Needs review', to: 'MANAGER' } };
    expect(pre(a, state(null))).toEqual([]);
    expect(post(a, state(null, { case: caseRow({ status: 'ESCALATED' }) }))).toEqual([['a0.case.status', true]]);
    expect(post(a, state(null))).toEqual([['a0.case.status', false]]);
  });
});

describe('actionOptions', () => {
  it('offers all nine actions and recommends replay for a captured, failed order', () => {
    const options = actionOptions(state(capturedOrderFailedSnapshot()));
    expect(options).toHaveLength(9);
    expect(options.filter((o) => o.recommended).map((o) => o.type)).toEqual(['REPLAY_WEBHOOK_EVENT']);
    const refund = options.find((o) => o.type === 'INITIATE_REFUND')!;
    expect(refund).toMatchObject({ editable: ['amountMinor', 'reason'], maxAmountMinor: 1_249_900, available: true });
    const sync = options.find((o) => o.type === 'SYNC_REFUND_STATUS')!;
    expect(sync.available).toBe(false);
    expect(sync.unavailableReason).toBeTruthy();
    for (const o of options) expect(o.summary).not.toMatch(/—/);
  });
  it('recommends mark paid + ledger once a replay failed, or the order is locked', () => {
    const s = capturedOrderFailedSnapshot();
    const history = [{ actionTypes: ['REPLAY_WEBHOOK_EVENT' as const], status: 'VALIDATED' as const, verdict: 'FAIL' as const }];
    expect(actionOptions(state(s), history).filter((o) => o.recommended).map((o) => o.type)).toEqual(['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY']);
    const locked = withSnapshot(s, { order: { ...s.order, lockedReason: 'VERSION_CONFLICT' } });
    expect(actionOptions(state(locked)).filter((o) => o.recommended).map((o) => o.type)).toEqual(['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY']);
  });
  it('targets the extra capture for a duplicate', () => {
    const dup = gwPayment({ id: 'gwp_2', capturedAt: ago(DAY_MS) });
    const s = withSnapshot(healthySnapshot(), { gateway: [gwPayment(), dup] });
    const options = actionOptions(state(s, { case: caseRow({ type: 'DUPLICATE' }) }));
    const refund = options.find((o) => o.type === 'INITIATE_REFUND')!;
    expect(refund.recommended).toBe(true);
    expect(refund.action).toMatchObject({ params: { gwPaymentId: 'gwp_2', amountMinor: 1_249_900 } });
  });
});

describe('idempotency key', () => {
  const a: CatalogAction = { type: 'INITIATE_REFUND', params: { gwPaymentId: 'gwp_1', amountMinor: 100, reason: 'x y z' } };
  it('is stable across key order and differs by resolution, index and params', () => {
    const reordered = { type: 'INITIATE_REFUND', params: { reason: 'x y z', amountMinor: 100, gwPaymentId: 'gwp_1' } } as CatalogAction;
    expect(stableJson(reordered.params)).toBe(stableJson(a.params));
    expect(idempotencyKey('rsl_1', 0, reordered)).toBe(idempotencyKey('rsl_1', 0, a));
    expect(idempotencyKey('rsl_1', 0, a)).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey('rsl_2', 0, a)).not.toBe(idempotencyKey('rsl_1', 0, a));
    expect(idempotencyKey('rsl_1', 1, a)).not.toBe(idempotencyKey('rsl_1', 0, a));
    expect(idempotencyKey('rsl_1', 0, { ...a, params: { ...a.params, amountMinor: 101 } })).not.toBe(idempotencyKey('rsl_1', 0, a));
  });
});

describe('matrix after fixes', () => {
  it('a failed delivery stops being a mismatch once the payment record caught up', () => {
    const fixed = withSnapshot(healthySnapshot(), { webhooks: [delivery({ fail: true })] });
    const cell = buildMatrix(fixed).cells.WEBHOOK;
    expect(cell).toMatchObject({ status: 'HTTP 500 ×3', mismatch: false });
    expect(buildMatrix(capturedOrderFailedSnapshot()).cells.WEBHOOK.mismatch).toBe(true);
  });
});
