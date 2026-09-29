/**
 * D069: a case closes by itself only when detection re-reads the order and every system now
 * agrees. Runs on PGlite through the same core the server uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCore, tables, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { generateScenario, resetDemoData } from './index';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-28T12:00:00.000Z');

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDemoData(core);
});

/** Opens a case pointing at a healthy order, as if a late webhook had since fixed the data. */
async function staleCase(type: 'PAYMENT_MISMATCH' | 'RISK_CASE' | 'SETTLEMENT_MISMATCH', status: 'OPEN' | 'ESCALATED' = 'OPEN') {
  const { created } = await generateScenario(core, { scenario: 'healthy_payment', seed: 7 });
  const orderId = created.orderIds[0]!;
  const opened = await core.db.transaction((tx) =>
    core.cases.openOrUpdate(
      {
        fingerprint: `${type}:${orderId}`,
        type,
        ruleIds: ['D1_CAPTURED_NOT_PAID'],
        severity: 'MEDIUM',
        priority: 1,
        amountMinor: 1_000_00,
        entityRefs: { orderId, paymentId: created.paymentIds[0] },
        matrix: blank(),
      },
      tx,
    ),
  );
  if (status !== 'OPEN') await core.db.update(tables.cases).set({ status }).where(eq(tables.cases.id, opened.case.id));
  return { caseId: opened.case.id, orderId };
}

function blank() {
  const cell = { status: '-', mismatch: false, detail: '' };
  return { cells: { GATEWAY: cell, ORDER: cell, LEDGER: cell, WEBHOOK: cell, SETTLEMENT: cell }, mismatched: [] } as never;
}

describe('auto-close when systems reconcile by themselves', () => {
  it('closes an OPEN case whose order now checks out, with a system-authored audit trail', async () => {
    const { caseId, orderId } = await staleCase('PAYMENT_MISMATCH');
    await core.reconciliation.checkOrders([orderId]);
    const detail = await core.cases.get(caseId, null);
    expect(detail.status).toBe('RESOLVED');
    expect(detail.resolution).toMatchObject({ by: 'SYSTEM' });
    expect(detail.resolution?.summary).toMatch(/all systems agree/i);
    const audits = (await core.audit.list({ limit: 20, caseId })).items.filter((i) => i.action === 'case.resolved');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor.id).toBe('system');
    // A second check changes nothing and writes no second audit row.
    await core.reconciliation.checkOrders([orderId]);
    expect((await core.audit.list({ limit: 20, caseId })).items.filter((i) => i.action === 'case.resolved')).toHaveLength(1);
  });

  it('leaves cases a person or agent is handling, and risk and settlement cases, alone', async () => {
    const escalated = await staleCase('PAYMENT_MISMATCH', 'ESCALATED');
    await core.reconciliation.checkOrders([escalated.orderId]);
    expect((await core.cases.get(escalated.caseId, null)).status).toBe('ESCALATED');

    await resetDemoData(core);
    const risk = await staleCase('RISK_CASE');
    await core.reconciliation.checkOrders([risk.orderId]);
    expect((await core.cases.get(risk.caseId, null)).status).toBe('OPEN');

    await resetDemoData(core);
    const settlement = await staleCase('SETTLEMENT_MISMATCH');
    await core.reconciliation.checkOrders([settlement.orderId]);
    expect((await core.cases.get(settlement.caseId, null)).status).toBe('OPEN');
  });

  it('does not close a case while its order still has a mismatch', async () => {
    const { created, casesOpened } = await generateScenario(core, { scenario: 'captured_order_failed', seed: 1 });
    await core.reconciliation.checkOrders(created.orderIds);
    await core.reconciliation.sweep();
    expect((await core.cases.get(casesOpened[0]!.id, null)).status).toBe('OPEN');
  });
});
