import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCENARIOS, type SystemKey } from '@payops/shared';
import { createCore, tables, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { generateScenario, resetDemoData } from './index';

let t: TestDatabase;
let core: Core;

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock: fixedClock('2026-09-28T12:00:00.000Z') });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDemoData(core);
});

const allCases = () => core.cases.list({ scope: 'all', limit: 100 });

describe('scenarios', () => {
  for (const info of SCENARIOS) {
    it(`${info.key} opens ${info.expectedCaseType ?? 'no case'}`, async () => {
      const result = await generateScenario(core, { scenario: info.key, seed: 42 });
      const cases = await allCases();
      if (info.expectedCaseType === null) {
        expect(result.casesOpened).toEqual([]);
        expect(cases.items).toEqual([]);
      } else {
        expect(result.casesOpened.map((c) => c.type)).toEqual([info.expectedCaseType]);
        expect(cases.items.map((c) => c.type)).toEqual([info.expectedCaseType]);
      }
    });
  }

  const matrixOf = async (scenario: (typeof SCENARIOS)[number]['key']): Promise<SystemKey[]> => {
    const { casesOpened } = await generateScenario(core, { scenario, seed: 7 });
    const detail = await core.cases.get(casesOpened[0]!.id);
    return detail.matrix.mismatched;
  };

  it('captured_order_failed marks order, ledger and webhook', async () => {
    const { casesOpened } = await generateScenario(core, { scenario: 'captured_order_failed', seed: 7 });
    const detail = await core.cases.get(casesOpened[0]!.id);
    expect(detail.matrix.mismatched).toEqual(['ORDER', 'LEDGER', 'WEBHOOK']);
    expect(detail).toMatchObject({
      displayId: 'PAY-0001',
      severity: 'HIGH',
      amountMinor: 1_249_900,
      ruleIds: ['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING'],
    });
    expect(detail.matrix.cells.WEBHOOK.status).toBe('HTTP 500 ×3');
    expect(detail.matrix.cells.SETTLEMENT.status).toBe('SETTLED');
    expect(detail.notes.map((n) => n.text)).toEqual([
      'I was charged ₹12,499 for my order but the app says the payment failed. Please check.',
    ]);
    expect(detail.lifecycle.some((e) => e.title === 'payment.captured delivery failed')).toBe(true);
    expect(detail.customer?.name).toBeTruthy();
    expect(detail.merchant?.name).toBe('Kavya Electronics');
  });

  it('settlement_mismatch marks settlement and sizes the shortfall', async () => {
    const { casesOpened, created } = await generateScenario(core, { scenario: 'settlement_mismatch', seed: 7 });
    expect(created.batchIds).toHaveLength(1);
    expect(created.paymentIds).toHaveLength(6);
    const detail = await core.cases.get(casesOpened[0]!.id);
    expect(detail.matrix.mismatched).toEqual(['SETTLEMENT']);
    expect(detail.amountMinor).toBe(13_924);
    expect(detail.severity).toBe('MEDIUM');
    expect(detail.primaryRef.batchId).toBe(created.batchIds[0]);
    expect(detail.matrix.cells.SETTLEMENT.detail).toBe('Fee ₹417.72 vs contract ₹278.48');
    const [batch] = await t.db.select().from(tables.settlements);
    expect(batch).toMatchObject({ status: 'MISMATCH', reportedNetMinor: batch!.expectedNetMinor - 13_924 });
  });

  it('refund_stuck marks ledger and webhook', async () => {
    expect(await matrixOf('refund_stuck')).toEqual(['LEDGER', 'WEBHOOK']);
  });

  it('refund_never_initiated marks the order and is critical', async () => {
    const { casesOpened } = await generateScenario(core, { scenario: 'refund_never_initiated', seed: 9 });
    const detail = await core.cases.get(casesOpened[0]!.id);
    expect(detail.matrix.mismatched).toEqual(['ORDER']);
    expect(detail).toMatchObject({ severity: 'CRITICAL', ruleIds: ['D6_REFUND_MISSING'], amountMinor: 7_800_000 });
  });

  it('duplicate_capture marks the gateway', async () => {
    expect(await matrixOf('duplicate_capture')).toEqual(['GATEWAY']);
  });

  it('suspicious_payment is consistent across systems', async () => {
    const { casesOpened } = await generateScenario(core, { scenario: 'suspicious_payment', seed: 7 });
    const detail = await core.cases.get(casesOpened[0]!.id);
    expect(detail.matrix.mismatched).toEqual([]);
    expect(detail).toMatchObject({ severity: 'HIGH', ruleIds: ['D8_RISK_VELOCITY'] });
    expect(detail.lifecycle.find((e) => e.system === 'RISK')?.title).toBe('8 failed payment attempts in 42 min');
  });

  it.each([
    ['showcase_webhook_recovery', 'PAYMENT_MISMATCH', ['ORDER', 'LEDGER', 'WEBHOOK']],
    ['showcase_duplicate_capture', 'DUPLICATE', ['GATEWAY']],
    ['showcase_settlement_dispute', 'SETTLEMENT_MISMATCH', ['SETTLEMENT']],
    ['showcase_ledger_gap', 'PAYMENT_MISMATCH', ['LEDGER']],
  ] as const)('%s opens a critical case with a real cross-system fault', async (scenario, type, mismatched) => {
    const { casesOpened } = await generateScenario(core, { scenario, seed: 71 });
    expect(casesOpened).toHaveLength(1);
    const detail = await core.cases.get(casesOpened[0]!.id);
    expect(detail).toMatchObject({ type, severity: 'CRITICAL' });
    expect(detail.matrix.mismatched).toEqual(mismatched);
    if (scenario === 'showcase_settlement_dispute') expect(detail.amountMinor).toBe(7_080_000);
  });

  it('adversarial variants keep the same record faults as their plain scenarios, with a misleading note', async () => {
    const mis = await generateScenario(core, { scenario: 'misleading_note', seed: 7 });
    const misDetail = await core.cases.get(mis.casesOpened[0]!.id);
    expect(misDetail.matrix.mismatched).toEqual(['ORDER', 'LEDGER', 'WEBHOOK']);
    expect(misDetail.notes.map((n) => n.text)[0]).toContain('charged twice');

    await resetDemoData(core);
    const conf = await generateScenario(core, { scenario: 'conflicting_evidence', seed: 7 });
    const confDetail = await core.cases.get(conf.casesOpened[0]!.id);
    expect(confDetail.notes.map((n) => n.text)[0]).toContain('refund');
    expect(confDetail.matrix.mismatched).toContain('ORDER');
  });

  describe('webhook event log (P3 task 2)', () => {
    it('every seeded gateway delivery also appears in our event log, with the same attempts', async () => {
      await generateScenario(core, { scenario: 'captured_order_failed', seed: 7 });
      const deliveries = await t.db.select().from(tables.gwWebhookDeliveries);
      const log = await t.db.select().from(tables.webhookEvents);
      expect(deliveries.length).toBeGreaterThan(0);
      expect(log.map((e) => e.id).sort()).toEqual(deliveries.map((d) => d.id).sort());
      const failed = log.find((e) => e.status !== 'PROCESSED');
      expect(failed).toMatchObject({ status: 'DEAD', attemptCount: 3, nextRetryAt: null });
      expect(failed?.attempts.every((a) => a.source === 'GATEWAY' && a.httpStatus === 500)).toBe(true);
    });

    it('a still-retrying delivery is FAILED in the log with the gateway attempts', async () => {
      await generateScenario(core, { scenario: 'late_webhook_retrying', seed: 7 });
      const [pending] = (await core.webhookEvents.list({ limit: 25 })).items.filter((e) => e.lastHttpStatus === 503);
      expect(pending).toMatchObject({ status: 'FAILED', attemptCount: 2 });
    });
  });

  describe('messy variants (P3)', () => {
    const detailOf = async (scenario: (typeof SCENARIOS)[number]['key']) => {
      const { casesOpened } = await generateScenario(core, { scenario, seed: 33 });
      expect(casesOpened).toHaveLength(1);
      return core.cases.get(casesOpened[0]!.id);
    };

    it('late_webhook_retrying shows a pending delivery, not a failed one', async () => {
      const detail = await detailOf('late_webhook_retrying');
      expect(detail.ruleIds).toEqual(['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING']);
      expect(detail.matrix.mismatched).toEqual(['ORDER', 'LEDGER']);
      expect(detail.matrix.cells.WEBHOOK.status).toBe('PENDING');
    });

    it('stale_failure_after_capture leaves the order FAILED after it was PAID, with the ledger credited', async () => {
      const detail = await detailOf('stale_failure_after_capture');
      expect(detail.ruleIds).toEqual(['D1_CAPTURED_NOT_PAID']);
      expect(detail.matrix.mismatched).toEqual(['ORDER']);
      const [order] = await t.db.select().from(tables.orders);
      expect(order!.status).toBe('FAILED');
      expect(order!.timeline.map((e) => e.to)).toEqual(['PENDING', 'PAID', 'FAILED']);
    });

    it('partial_refund_stuck is a partial refund pending past the SLA', async () => {
      const detail = await detailOf('partial_refund_stuck');
      expect(detail.ruleIds).toEqual(['D5_REFUND_PENDING_SLA']);
      expect(detail.amountMinor).toBe(120_000);
      const [gw] = await t.db.select().from(tables.gwPayments);
      expect(gw).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 120_000 });
    });

    it('refund_never_reached_gateway has no gateway refund at all', async () => {
      const detail = await detailOf('refund_never_reached_gateway');
      expect(detail.ruleIds).toEqual(['D5_REFUND_PENDING_SLA']);
      expect(await t.db.select().from(tables.gwRefunds)).toEqual([]);
    });

    it('partial_refund_shortfall owes only the unrefunded remainder', async () => {
      const detail = await detailOf('partial_refund_shortfall');
      expect(detail.ruleIds).toEqual(['D6_REFUND_MISSING']);
      expect(detail.amountMinor).toBe(1_500_000 - 600_000);
      expect(await t.db.select().from(tables.refunds)).toEqual([]);
    });

    it('cancel_raced_capture cancels the order before the capture lands', async () => {
      const detail = await detailOf('cancel_raced_capture');
      expect(detail.ruleIds).toEqual(['D6_REFUND_MISSING']);
      const [order] = await t.db.select().from(tables.orders);
      expect(order!.timeline.map((e) => e.to)).toEqual(['PENDING', 'CANCELLED']);
    });
  });

  it('rejects the same scenario and seed twice', async () => {
    await generateScenario(core, { scenario: 'captured_order_failed', seed: 5 });
    await expect(generateScenario(core, { scenario: 'captured_order_failed', seed: 5 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await allCases()).items).toHaveLength(1);
  });

  it('is deterministic for a seed', async () => {
    const a = await generateScenario(core, { scenario: 'duplicate_capture', seed: 11, noise: 3 });
    await resetDemoData(core);
    const b = await generateScenario(core, { scenario: 'duplicate_capture', seed: 11, noise: 3 });
    expect(b.created).toEqual(a.created);
  });

  it('noise payments open no cases, and re-checking is stable', async () => {
    const result = await generateScenario(core, { scenario: 'healthy_payment', seed: 3, noise: 40 });
    expect(result.created.paymentIds).toHaveLength(41);
    expect(result.casesOpened).toEqual([]);
    const sweep = await core.reconciliation.sweep();
    expect(sweep).toMatchObject({ checked: 41 + result.created.batchIds.length, opened: 0, updated: 0 });
    const flagged = await core.payments.list({ limit: 100, mismatchOnly: true });
    expect(flagged.items).toEqual([]);
  });

  it('re-detection merges into the open case instead of opening another', async () => {
    const first = await generateScenario(core, { scenario: 'captured_order_failed', seed: 21 });
    const again = await core.reconciliation.checkOrders([first.created.orderIds[0]!]);
    expect(again).toMatchObject({ opened: 0, updated: 1, cases: [] });
    expect((await allCases()).items).toHaveLength(1);
  });

  it('writes audit events for detection and generation', async () => {
    await generateScenario(core, { scenario: 'refund_stuck', seed: 1 });
    const audit = await core.audit.list({ limit: 10 });
    // The test clock is frozen, so all three share a timestamp; compare as a set.
    expect(audit.items.map((a) => a.action).sort()).toEqual(['case.opened', 'simulator.generated', 'simulator.reset']);
  });
});
