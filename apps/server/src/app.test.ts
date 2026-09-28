import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type {
  CaseDetail,
  CaseListItem,
  GenerateScenarioResult,
  OverviewMetrics,
  Page,
  PaymentDetail,
  PaymentListItem,
  AuditEventItem,
} from '@payops/shared';
import { createCore, createLogger, loadServerEnv, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { createApp } from './app';
import { seedDemoUsers } from './auth/demo-users';

let t: TestDatabase;
let core: Core;
let app: Express;
/** Signed-in agents keep their session cookie across requests. */
let ops: ReturnType<typeof request.agent>;
const published: Array<{ room: string; event: string }> = [];

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  t = await startTestDatabase();
  core = createCore({
    db: t.db,
    clock: fixedClock('2026-09-28T12:00:00.000Z'),
    events: { publish: (room, event) => void published.push({ room, event }) },
  });
  const env = loadServerEnv({ NODE_ENV: 'test' });
  app = createApp({ env, log: createLogger(env, 'test'), database: t, core });
  await seedDemoUsers(t.db);
  ops = request.agent(app);
  await ops.post('/api/auth/demo-login').send({ email: 'ops@payops.dev' }).expect(200);
});
afterAll(async () => {
  await t.close();
});

async function generate(scenario: string, seed: number, noise = 0): Promise<GenerateScenarioResult> {
  const res = await ops.post('/api/simulator/scenarios').send({ scenario, seed, noise }).expect(201);
  return res.body as GenerateScenarioResult;
}

describe('simulator API', () => {
  it('lists scenarios', async () => {
    const res = await ops.get('/api/simulator/scenarios').expect(200);
    expect(res.body).toHaveLength(9);
  });

  it('generates a scenario and the case appears in the queue', async () => {
    await ops.post('/api/simulator/reset').send({}).expect(200);
    const result = await generate('captured_order_failed', 1, 12);
    expect(result).toMatchObject({ scenario: 'captured_order_failed', seed: 1 });
    expect(result.casesOpened).toEqual([expect.objectContaining({ type: 'PAYMENT_MISMATCH', displayId: 'PAY-0001' })]);
    expect(published).toContainEqual({ room: 'ops', event: 'case.created' });

    const list = (await ops.get('/api/cases').expect(200)).body as Page<CaseListItem>;
    expect(list.items.map((c) => c.id)).toEqual([result.casesOpened[0]?.id]);
  });

  it('rejects the same seed twice with 409', async () => {
    const res = await ops.post('/api/simulator/scenarios').send({ scenario: 'captured_order_failed', seed: 1 }).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('validates the body', async () => {
    const res = await ops.post('/api/simulator/scenarios').send({ scenario: 'nope' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('cases API', () => {
  beforeAll(async () => {
    await generate('refund_never_initiated', 2);
    await generate('settlement_mismatch', 3);
  });

  it('orders the queue by priority and returns list items', async () => {
    const body = (await ops.get('/api/cases?limit=10').expect(200)).body as Page<CaseListItem>;
    expect(body.items.map((c) => c.type)).toEqual(['REFUND_EXCEPTION', 'PAYMENT_MISMATCH', 'SETTLEMENT_MISMATCH']);
    expect(body.total).toBe(3);
    const item = body.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ['amountMinor', 'assignee', 'displayId', 'id', 'mismatched', 'openedAt', 'primaryRef', 'priority', 'ruleIds', 'severity', 'signals', 'status', 'type', 'updatedAt'].sort(),
    );
    expect(item).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', mismatched: ['ORDER'], assignee: null });
  });

  it('filters and paginates', async () => {
    const first = (await ops.get('/api/cases?limit=2').expect(200)).body as Page<CaseListItem>;
    expect(first.items).toHaveLength(2);
    const second = (await ops.get(`/api/cases?limit=2&cursor=${first.nextCursor}`).expect(200)).body as Page<CaseListItem>;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const typed = (await ops.get('/api/cases?type=SETTLEMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    expect(typed.items.map((c) => c.type)).toEqual(['SETTLEMENT_MISMATCH']);
    const closed = (await ops.get('/api/cases?scope=closed').expect(200)).body as Page<CaseListItem>;
    expect(closed.items).toEqual([]);
  });

  it('returns case detail with matrix, lifecycle and notes', async () => {
    const list = (await ops.get('/api/cases?type=PAYMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    const detail = (await ops.get(`/api/cases/${list.items[0]!.id}`).expect(200)).body as CaseDetail;
    expect(detail.matrix.mismatched).toEqual(['ORDER', 'LEDGER', 'WEBHOOK']);
    expect(Object.keys(detail.matrix.cells)).toEqual(['GATEWAY', 'ORDER', 'LEDGER', 'WEBHOOK', 'SETTLEMENT']);
    expect(detail.matrix.cells.GATEWAY.reference).toBe(true);
    expect(detail.lifecycle.length).toBeGreaterThan(5);
    expect(detail.notes).toHaveLength(1);
    expect(detail.entityRefs.paymentId).toBe(detail.primaryRef.paymentId);
    expect(detail.customer).not.toBeNull();
    expect(detail.resolution).toBeNull();
  });

  it('422s a bad query', async () => {
    const res = await ops.get('/api/cases?status=DONE').expect(422);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    await ops.get('/api/cases?limit=0').expect(422);
  });

  it('400s a malformed cursor and 404s an unknown case', async () => {
    await ops.get('/api/cases?cursor=zzz').expect(400);
    const res = await ops.get('/api/cases/case_unknown').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('payments API', () => {
  it('paginates newest first without overlap', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/payments?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await ops.get(url).expect(200)).body as Page<PaymentListItem>;
      seen.push(...body.items.map((p) => p.createdAt + p.paymentId));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    // 1 + 12 noise + 1 + 6 payments generated above
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
    expect([...seen].sort().reverse()).toEqual(seen);
    expect(pages).toBe(4);
  });

  it('filters mismatches and the rows agree with the matrix', async () => {
    const body = (await ops.get('/api/payments?mismatchOnly=true&limit=50').expect(200)).body as Page<PaymentListItem>;
    expect(body.items).toHaveLength(3);
    for (const p of body.items) expect(p.mismatch).toBe(true);
    const failed = body.items.find((p) => p.orderStatus === 'FAILED');
    expect(failed).toMatchObject({ gatewayStatus: 'CAPTURED', ledger: 'MISSING', settlement: 'SETTLED', internalStatus: 'PENDING' });
    expect(failed?.openCase?.displayId).toBe('PAY-0001');
    const fee = body.items.find((p) => p.settlement === 'MISMATCH');
    expect(fee?.openCase?.displayId).toMatch(/^STL-/);
  });

  it('filters by order status, gateway status and id prefix', async () => {
    const cancelled = (await ops.get('/api/payments?orderStatus=CANCELLED').expect(200)).body as Page<PaymentListItem>;
    expect(cancelled.items.map((p) => p.amountMinor)).toEqual([7_800_000]);
    const refunded = (await ops.get('/api/payments?gatewayStatus=REFUNDED').expect(200)).body as Page<PaymentListItem>;
    expect(refunded.items).toEqual([]);
    const target = cancelled.items[0]!;
    for (const q of [target.paymentId.slice(0, 8), target.gwPaymentId, target.orderId.slice(0, 10)]) {
      const hit = (await ops.get(`/api/payments?q=${q}`).expect(200)).body as Page<PaymentListItem>;
      expect(hit.items.map((p) => p.paymentId)).toContain(target.paymentId);
    }
  });

  it('returns payment detail and 404s unknown ids', async () => {
    const list = (await ops.get('/api/payments?orderStatus=CANCELLED').expect(200)).body as Page<PaymentListItem>;
    const detail = (await ops.get(`/api/payments/${list.items[0]!.paymentId}`).expect(200)).body as PaymentDetail;
    expect(detail.card).toMatchObject({ network: 'AMEX', last4: '1005' });
    expect(detail.matrix.mismatched).toEqual(['ORDER']);
    expect(detail.lifecycle.map((e) => e.title)).toContain('Order PAID to CANCELLED');
    await ops.get('/api/payments/pay_nope').expect(404);
    await ops.get('/api/payments?gatewayStatus=LOST').expect(422);
  });
});

describe('overview and audit API', () => {
  it('returns overview metrics', async () => {
    const body = (await ops.get('/api/overview').expect(200)).body as OverviewMetrics;
    expect(body.openExceptions).toBe(3);
    expect(body.exceptionsByType).toHaveLength(14);
    expect(body.exceptionsByType[13]).toEqual({ date: '2026-09-28', PAYMENT_MISMATCH: 1, REFUND_EXCEPTION: 1, SETTLEMENT_MISMATCH: 1 });
    expect(body.oldestOpen).toHaveLength(3);
    expect(body.resolvedByAgent7d).toBe(0);
    expect(body.capturedTodayCount).toBeGreaterThanOrEqual(0);
  });

  it('lists audit events by case', async () => {
    const cases = (await ops.get('/api/cases?type=PAYMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    const caseId = cases.items[0]!.id;
    const body = (await ops.get(`/api/audit?caseId=${caseId}`).expect(200)).body as Page<AuditEventItem>;
    expect(body.items.map((a) => a.action)).toEqual(['case.opened']);
    const all = (await ops.get('/api/audit?limit=2').expect(200)).body as Page<AuditEventItem>;
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).not.toBeNull();
  });
});
