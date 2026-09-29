import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RootCause } from '@payops/shared';
import { createCore, type Core } from '../container';
import { agentRuns } from '../db/schema';
import { buildMatrix } from '../reconciliation/matrix';
import { priorityOf } from '../reconciliation/candidates';
import { healthySnapshot } from '../reconciliation/test-factory';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-28T12:00:00.000Z');
const ops = { id: 'usr_ops1', name: 'Ananya Rao' };
const ops2 = { id: 'usr_ops2', name: 'Rahul Menon' };

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

/** A case with one run whose diagnosis carries `rootCause` (null = the run has no diagnosis yet). */
async function seedRun(rootCause: RootCause | null) {
  const { case: c } = await core.db.transaction((tx) =>
    core.cases.openOrUpdate(
      {
        fingerprint: 'PAYMENT_MISMATCH:pay_1',
        type: 'PAYMENT_MISMATCH',
        ruleIds: ['D1_CAPTURED_NOT_PAID'],
        severity: 'HIGH',
        priority: priorityOf('HIGH', 1_249_900),
        amountMinor: 1_249_900,
        entityRefs: { paymentId: 'pay_1', orderId: 'ord_1' },
        matrix: buildMatrix(healthySnapshot()),
      },
      tx,
    ),
  );
  const now = clock.now();
  await core.db.insert(agentRuns).values({
    id: 'run_1',
    caseId: c.id,
    status: 'RESOLVED',
    attempt: 1,
    budget: { llmCalls: 0, jevCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    diagnosis: rootCause ? { rootCause, narrative: 'x', confidence: 0.9, supportingFindingIds: [], path: 'FAST' } : null,
    createdAt: now,
    updatedAt: now,
  });
  return { caseId: c.id, runId: 'run_1' };
}

describe('FeedbackService', () => {
  it('stores a RIGHT verdict with the label the agent gave, and audits it', async () => {
    const { runId, caseId } = await seedRun('WEBHOOK_PROCESSING_FAILURE');
    const item = await core.feedback.submit(runId, { verdict: 'RIGHT', reason: '' }, ops);
    expect(item).toMatchObject({ runId, caseId, verdict: 'RIGHT', diagnosedRootCause: 'WEBHOOK_PROCESSING_FAILURE', givenById: ops.id, givenByName: ops.name, correctRootCause: null });
    const audit = await core.audit.list({ limit: 10, caseId });
    expect(audit.items.map((a) => a.action)).toContain('diagnosis.feedback');
  });

  it('stores a WRONG verdict with a reason and the operator\'s corrected cause', async () => {
    const { runId } = await seedRun('ORDER_STATE_DIVERGED');
    const item = await core.feedback.submit(runId, { verdict: 'WRONG', reason: 'The webhook returned 500.', correctRootCause: 'WEBHOOK_PROCESSING_FAILURE' }, ops);
    expect(item).toMatchObject({ verdict: 'WRONG', reason: 'The webhook returned 500.', correctRootCause: 'WEBHOOK_PROCESSING_FAILURE' });
  });

  it('replaces the same operator\'s earlier verdict instead of adding a second row', async () => {
    const { runId } = await seedRun('DUPLICATE_CAPTURE');
    await core.feedback.submit(runId, { verdict: 'WRONG', reason: 'Only one capture.' }, ops);
    await core.feedback.submit(runId, { verdict: 'RIGHT', reason: '' }, ops);
    const list = await core.feedback.listForRun(runId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ verdict: 'RIGHT', reason: '' });
  });

  it('keeps separate verdicts from different operators', async () => {
    const { runId } = await seedRun('DUPLICATE_CAPTURE');
    await core.feedback.submit(runId, { verdict: 'RIGHT', reason: '' }, ops);
    await core.feedback.submit(runId, { verdict: 'WRONG', reason: 'Two captures were refunded already.' }, ops2);
    const list = await core.feedback.listForRun(runId);
    expect(list.map((f) => f.givenById).sort()).toEqual([ops.id, ops2.id]);
  });

  it('rejects feedback on a run that has no diagnosis yet', async () => {
    const { runId } = await seedRun(null);
    await expect(core.feedback.submit(runId, { verdict: 'RIGHT', reason: '' }, ops)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects feedback on a run that does not exist', async () => {
    await expect(core.feedback.submit('run_missing', { verdict: 'RIGHT', reason: '' }, ops)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
