import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type {
  AgentRunItem,
  CaseDetail,
  CaseSourceRecords,
  CaseListItem,
  GenerateScenarioResult,
  GroundingReport,
  OverviewMetrics,
  Page,
  PaymentDetail,
  PaymentListItem,
  AuditEventItem,
} from '@payops/shared';
import { SCENARIOS, type WebhookLogDetail, type HandoffSummary, type OperatorNoteItem, type SavedViewItem } from '@payops/shared';
import { createRunRow, patchRunRow } from '@payops/agents';
import { createCore, createLogger, loadServerEnv, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import type { PgBoss } from 'pg-boss';
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
  const fakeBoss = { send: async () => null } as unknown as PgBoss;
  const env = loadServerEnv({ NODE_ENV: 'test' });
  app = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: fakeBoss });
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
    expect(res.body).toHaveLength(SCENARIOS.length);
    expect(res.body.map((scenario: { key: string }) => scenario.key)).toEqual(SCENARIOS.map((scenario) => scenario.key));
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

  it('undoes a reset by restoring the snapshot', async () => {
    const before = (await ops.get('/api/cases').expect(200)).body as Page<CaseListItem>;
    expect(before.items.length).toBeGreaterThan(0);
    await ops.post('/api/simulator/reset').send({}).expect(200);
    const wiped = (await ops.get('/api/cases').expect(200)).body as Page<CaseListItem>;
    expect(wiped.items).toHaveLength(0);
    expect((await ops.get('/api/simulator/reset-status').expect(200)).body.canUndo).toBe(true);
    await ops.post('/api/simulator/undo-reset').send({}).expect(200);
    const after = (await ops.get('/api/cases').expect(200)).body as Page<CaseListItem>;
    expect(after.items.map((c) => c.id)).toEqual(before.items.map((c) => c.id));
    expect((await ops.get('/api/simulator/reset-status').expect(200)).body.canUndo).toBe(false);
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

  it('shows fresh source records for payment and settlement cases without an agent run', async () => {
    const list = (await ops.get('/api/cases?limit=10').expect(200)).body as Page<CaseListItem>;
    const paymentCase = list.items.find((item) => item.type === 'PAYMENT_MISMATCH')!;
    const paymentRecords = (await ops.get(`/api/cases/${paymentCase.id}/records`).expect(200)).body as CaseSourceRecords;
    expect(paymentRecords.caseId).toBe(paymentCase.id);
    expect(paymentRecords.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'GATEWAY', kind: 'Gateway payment' }),
      expect.objectContaining({ system: 'ORDER', kind: 'Order' }),
      expect.objectContaining({ system: 'WEBHOOK', kind: 'Webhook delivery' }),
    ]));
    const batchCase = list.items.find((item) => item.type === 'SETTLEMENT_MISMATCH')!;
    const batchRecords = (await ops.get(`/api/cases/${batchCase.id}/records`).expect(200)).body as CaseSourceRecords;
    expect(batchRecords.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'SETTLEMENT', kind: 'Settlement batch', id: batchCase.primaryRef.batchId }),
      expect.objectContaining({ system: 'SETTLEMENT', kind: 'Gateway settlement line' }),
    ]));
  });

  it('orders the queue by priority and returns list items', async () => {
    const body = (await ops.get('/api/cases?limit=10').expect(200)).body as Page<CaseListItem>;
    expect(body.items.map((c) => c.type)).toEqual(['REFUND_EXCEPTION', 'PAYMENT_MISMATCH', 'SETTLEMENT_MISMATCH']);
    expect(body.total).toBe(3);
    const item = body.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ['amountMinor', 'assignee', 'displayId', 'dueAt', 'id', 'mismatched', 'openedAt', 'overdue', 'primaryRef', 'priority', 'ruleIds', 'severity', 'signals', 'status', 'type', 'updatedAt'].sort(),
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
    // Validator outcomes always report all three verdicts, zero-filled, so the chart never has a missing bar.
    expect(Object.keys(body.validatorOutcomes7d).sort()).toEqual(['FAIL', 'PARTIAL', 'PASS']);
    for (const n of Object.values(body.validatorOutcomes7d)) expect(n).toBeGreaterThanOrEqual(0);
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

describe('agent runs API: grounding round-trips (Phase 4 task 8, docs/DECISIONS.md D044)', () => {
  it('GET /api/runs/:id includes grounding: null until groundCheck has run, and the real report once it has', async () => {
    const cases = (await ops.get('/api/cases?type=PAYMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    const caseId = cases.items[0]!.id;
    const runId = 'run_grounding_apitest';
    await createRunRow(core, { id: runId, caseId });

    const fresh = (await ops.get(`/api/runs/${runId}`).expect(200)).body as AgentRunItem;
    expect(fresh.grounding).toBeNull(); // fast path / not yet checked (docs/03 §4a)

    const grounding: GroundingReport = { checked: 2, violations: [{ findingId: 'fd_02', reason: 'contradicted' }], sufficient: true };
    await patchRunRow(core, runId, { grounding });

    const checked = (await ops.get(`/api/runs/${runId}`).expect(200)).body as AgentRunItem;
    expect(checked.grounding).toEqual(grounding);
  });
});

describe('agent runs API: diagnosis feedback (P1 task 3, docs/DECISIONS.md D065)', () => {
  it('records feedback, lists it, validates a WRONG verdict, and keeps viewers read-only', async () => {
    const cases = (await ops.get('/api/cases?type=PAYMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    const runId = 'run_feedback_apitest';
    await createRunRow(core, { id: runId, caseId: cases.items[0]!.id });

    // No diagnosis yet: nothing to judge.
    await ops.put(`/api/runs/${runId}/feedback`).send({ verdict: 'RIGHT' }).expect(409);

    await patchRunRow(core, runId, {
      diagnosis: { rootCause: 'WEBHOOK_PROCESSING_FAILURE', narrative: 'The webhook failed.', confidence: 0.9, supportingFindingIds: [], path: 'FAST' },
    });

    // A WRONG verdict without a reason is a validation error.
    await ops.put(`/api/runs/${runId}/feedback`).send({ verdict: 'WRONG' }).expect(422);

    const saved = (await ops.put(`/api/runs/${runId}/feedback`).send({ verdict: 'WRONG', reason: 'The consumer returned 200.', correctRootCause: 'ORDER_STATE_DIVERGED' }).expect(200)).body;
    expect(saved).toMatchObject({ verdict: 'WRONG', diagnosedRootCause: 'WEBHOOK_PROCESSING_FAILURE', correctRootCause: 'ORDER_STATE_DIVERGED', givenByName: 'Ananya Rao' });

    const listed = (await ops.get(`/api/runs/${runId}/feedback`).expect(200)).body as Page<{ verdict: string }>;
    expect(listed.items.map((f) => f.verdict)).toEqual(['WRONG']);

    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.get(`/api/runs/${runId}/feedback`).expect(200);
    await viewer.put(`/api/runs/${runId}/feedback`).send({ verdict: 'RIGHT' }).expect(403);
  });
});

describe('agent control API (P1 task 4, docs/DECISIONS.md D066)', () => {
  it('is NORMAL by default, only managers can change it, and a pause blocks new investigations', async () => {
    const start = (await ops.get('/api/agent-control').expect(200)).body;
    expect(start).toMatchObject({ mode: 'NORMAL', reason: '' });

    // An Ops analyst can read but not change it.
    await ops.put('/api/agent-control').send({ mode: 'PAUSED', reason: 'Gateway outage.' }).expect(403);

    const manager = request.agent(app);
    await manager.post('/api/auth/demo-login').send({ email: 'manager@payops.dev' }).expect(200);
    // Limiting the agent needs a reason.
    await manager.put('/api/agent-control').send({ mode: 'PAUSED' }).expect(422);
    const paused = (await manager.put('/api/agent-control').send({ mode: 'PAUSED', reason: 'Gateway outage.' }).expect(200)).body;
    expect(paused).toMatchObject({ mode: 'PAUSED', reason: 'Gateway outage.', changedByName: 'Meera Iyer' });

    const cases = (await ops.get('/api/cases?type=PAYMENT_MISMATCH').expect(200)).body as Page<CaseListItem>;
    const blocked = await ops.post(`/api/cases/${cases.items[0]!.id}/runs`).send({}).expect(409);
    expect(blocked.body.error.message).toContain('The agent is paused: Gateway outage.');

    await manager.put('/api/agent-control').send({ mode: 'NORMAL' }).expect(200);
    await ops.post(`/api/cases/${cases.items[0]!.id}/runs`).send({}).expect(202);
  });
});

describe('case assignment API (P2 task 1, docs/DECISIONS.md D067)', () => {
  it('lets OPS assign and clear, rejects viewers and non-OPS assignees, and filters the queue', async () => {
    const loginId = async (email: string) => {
      const res = await request.agent(app).post('/api/auth/demo-login').send({ email }).expect(200);
      return ((res.body as { user?: { id: string } }).user ?? (res.body as { id: string })).id;
    };
    const [opsId, viewerId] = [await loginId('ops2@payops.dev'), await loginId('viewer@payops.dev')];
    const list = (await ops.get('/api/cases?scope=open&limit=5').expect(200)).body as Page<CaseListItem>;
    const target = list.items[0]!;

    const assigned = (await ops.put(`/api/cases/${target.id}/assignee`).send({ assigneeId: opsId }).expect(200)).body as CaseListItem;
    expect(assigned.assignee).toMatchObject({ id: opsId, name: 'Rahul Menon' });
    const mine = (await ops.get(`/api/cases?scope=open&assigneeId=${opsId}`).expect(200)).body as Page<CaseListItem>;
    expect(mine.items.map((c) => c.id)).toEqual([target.id]);

    await ops.put(`/api/cases/${target.id}/assignee`).send({ assigneeId: viewerId }).expect(422);
    await ops.put(`/api/cases/${target.id}/assignee`).send({}).expect(422);
    await ops.put('/api/cases/case_missing/assignee').send({ assigneeId: opsId }).expect(404);

    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.put(`/api/cases/${target.id}/assignee`).send({ assigneeId: null }).expect(403);

    const cleared = (await ops.put(`/api/cases/${target.id}/assignee`).send({ assigneeId: null }).expect(200)).body as CaseListItem;
    expect(cleared.assignee).toBeNull();
    const overdue = (await ops.get('/api/cases?scope=open&overdue=true').expect(200)).body as Page<CaseListItem>;
    expect(overdue.items).toEqual([]);
    await ops.get('/api/cases?overdue=maybe').expect(422);
  });
});

describe('operator workflow API (P2 task 2, docs/DECISIONS.md D068)', () => {
  it('adds and lists case notes, OPS only for writing', async () => {
    const list = (await ops.get('/api/cases?scope=open&limit=1').expect(200)).body as Page<CaseListItem>;
    const id = list.items[0]!.id;
    const note = (await ops.post(`/api/cases/${id}/notes`).send({ text: ' Called the merchant. ' }).expect(201)).body as OperatorNoteItem;
    expect(note).toMatchObject({ caseId: id, text: 'Called the merchant.', authorName: 'Ananya Rao' });
    const notes = (await ops.get(`/api/cases/${id}/notes`).expect(200)).body as Page<OperatorNoteItem>;
    expect(notes.items.map((n) => n.id)).toEqual([note.id]);

    await ops.post(`/api/cases/${id}/notes`).send({ text: '   ' }).expect(422);
    await ops.post('/api/cases/case_missing/notes').send({ text: 'x' }).expect(404);
    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.post(`/api/cases/${id}/notes`).send({ text: 'x' }).expect(403);
    await viewer.get(`/api/cases/${id}/notes`).expect(200);
  });

  it('keeps saved views private to their owner', async () => {
    const made = (await ops.post('/api/views').send({ name: 'My overdue', filters: { overdue: true, assigneeId: 'me' } }).expect(201)).body as SavedViewItem;
    await ops.post('/api/views').send({ name: 'My overdue', filters: {} }).expect(409);
    await ops.post('/api/views').send({ name: 'Bad', filters: { severity: 'SEVERE' } }).expect(422);
    await ops.post('/api/views').send({ name: 'Extra', filters: { nope: 1 } }).expect(422);

    const other = request.agent(app);
    await other.post('/api/auth/demo-login').send({ email: 'ops2@payops.dev' }).expect(200);
    expect(((await other.get('/api/views').expect(200)).body as Page<SavedViewItem>).items).toEqual([]);
    await other.delete(`/api/views/${made.id}`).send({}).expect(404);

    expect(((await ops.get('/api/views').expect(200)).body as Page<SavedViewItem>).items.map((v) => v.id)).toEqual([made.id]);
    await ops.delete(`/api/views/${made.id}`).send({}).expect(204);
    expect(((await ops.get('/api/views').expect(200)).body as Page<SavedViewItem>).items).toEqual([]);
  });

  it('returns the handoff summary and validates the window', async () => {
    const h = (await ops.get('/api/handoff?hours=12').expect(200)).body as HandoffSummary;
    expect(h.sinceHours).toBe(12);
    expect(h.open.total).toBe(3);
    expect(h.needsAttention.length).toBeGreaterThan(0);
    expect(((await ops.get('/api/handoff').expect(200)).body as HandoffSummary).sinceHours).toBe(8);
    await ops.get('/api/handoff?hours=0').expect(422);
    await ops.get('/api/handoff?hours=100').expect(422);
  });
});

describe('bulk approve API (D069)', () => {
  it('is OPS-only, validates the body and approves an eligible item proposed by someone else', async () => {
    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.post('/api/approvals/bulk-approve').send({ ids: ['apr_x'] }).expect(403);
    await ops.post('/api/approvals/bulk-approve').send({ ids: [] }).expect(422);

    const { casesOpened } = await generate('duplicate_capture', 9101);
    const caseId = casesOpened[0]!.id;
    const me = await ops.get('/api/auth/me').expect(200);
    const opsUser = { id: me.body.id as string, email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS' as const };
    const detail = await core.cases.get(caseId, opsUser);
    const actions = detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    await core.resolutions.propose(caseId, { actions, rationale: 'Refund the duplicate' }, opsUser);
    const pending = (await core.approvals.list({ scope: 'pending', limit: 10 }, null)).items.find((a) => a.case.id === caseId)!;

    // The proposer cannot bulk approve their own proposal.
    const own = await ops.post('/api/approvals/bulk-approve').send({ ids: [pending.id] }).expect(200);
    expect(own.body).toMatchObject({ approved: 0, skipped: 1 });

    const ops2 = request.agent(app);
    await ops2.post('/api/auth/demo-login').send({ email: 'ops2@payops.dev' }).expect(200);
    const res = await ops2.post('/api/approvals/bulk-approve').send({ ids: [pending.id] }).expect(200);
    expect(res.body).toMatchObject({ approved: 1, skipped: 0, failed: 0 });
  });
});

describe('undo API (D070)', () => {
  it('is OPS-only and refuses a resolution that posted nothing', async () => {
    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.post('/api/cases/cas_x/resolutions/res_x/undo').send({}).expect(403);

    const { casesOpened } = await generate('captured_order_failed', 9102);
    const caseId = casesOpened[0]!.id;
    const me = await ops.get('/api/auth/me').expect(200);
    const opsUser = { id: me.body.id as string, email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS' as const };
    const detail = await core.cases.get(caseId, opsUser);
    const actions = detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    const created = { body: await core.resolutions.propose(caseId, { actions, rationale: 'Replay the failed webhook' }, opsUser) };
    await ops.post(`/api/cases/${caseId}/resolutions/${created.body.id}/undo`).send({}).expect(409);
    await ops.post(`/api/cases/${caseId}/resolutions/res_missing/undo`).send({}).expect(404);
  });
});

describe('webhook event log API', () => {
  it('logs gateway deliveries, lets OPS replay one, and keeps viewers read-only', async () => {
    await ops.post('/api/simulator/reset').send({}).expect(200);
    await generate('captured_order_failed', 9301);
    const list = (await ops.get('/api/webhooks').expect(200)).body as Page<{ id: string; status: string }>;
    const failed = list.items.find((e) => e.status === 'DEAD');
    expect(failed).toBeDefined();
    const counts = (await ops.get('/api/webhooks/counts').expect(200)).body as { processed: number; failed: number; dead: number };
    expect(counts.failed + counts.processed + counts.dead).toBe(list.items.length);

    const detail = (await ops.get(`/api/webhooks/${failed!.id}`).expect(200)).body as WebhookLogDetail;
    expect(detail.payload.id).toBe(failed!.id);
    await ops.get('/api/webhooks/evt_missing').expect(404);
    await ops.get('/api/webhooks?status=BOGUS').expect(422);

    const viewer = request.agent(app);
    await viewer.post('/api/auth/demo-login').send({ email: 'viewer@payops.dev' }).expect(200);
    await viewer.get('/api/webhooks').expect(200);
    await viewer.post(`/api/webhooks/${failed!.id}/replay`).send({}).expect(403);

    const replayed = (await ops.post(`/api/webhooks/${failed!.id}/replay`).send({}).expect(200)).body as WebhookLogDetail;
    expect(replayed.attempts.at(-1)?.source).toBe('MANUAL');
    await ops.post('/api/webhooks/evt_missing/replay').send({}).expect(404);
  });
});
