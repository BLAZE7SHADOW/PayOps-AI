/**
 * Phase 2 "Done when": every MVP scenario can be resolved manually to validator PASS, with the
 * expected policy tier and a different approver where needed. Runs on PGlite through the same
 * core the server uses; the simulator plays the gateway.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CatalogAction, PolicyTier, ScenarioKey, SessionUser } from '@payops/shared';
import { AppError, createCore, tables, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { generateScenario, resetDemoData } from './index';

const ops: SessionUser = { id: 'usr_ops1', email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS' };
const ops2: SessionUser = { id: 'usr_ops2', email: 'ops2@payops.dev', name: 'Rahul Menon', role: 'OPS' };
const manager: SessionUser = { id: 'usr_mgr', email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER' };
const viewer: SessionUser = { id: 'usr_view', email: 'viewer@payops.dev', name: 'Kabir Shah', role: 'VIEWER' };

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

async function openCase(scenario: ScenarioKey, seed = 1): Promise<string> {
  const result = await generateScenario(core, { scenario, seed });
  expect(result.casesOpened).toHaveLength(1);
  return result.casesOpened[0]!.id;
}

async function recommended(caseId: string, who: SessionUser = ops): Promise<CatalogAction[]> {
  const detail = await core.cases.get(caseId, who);
  return detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
}

interface Expectation {
  scenario: ScenarioKey;
  types: string[];
  tier: PolicyTier;
  approver?: SessionUser;
  finalCase: 'RESOLVED' | 'ESCALATED';
}

const EXPECTED: Expectation[] = [
  { scenario: 'captured_order_failed', types: ['REPLAY_WEBHOOK_EVENT'], tier: 'AUTO', finalCase: 'RESOLVED' },
  { scenario: 'injected_refund_request', types: ['REPLAY_WEBHOOK_EVENT'], tier: 'AUTO', finalCase: 'RESOLVED' },
  { scenario: 'refund_stuck', types: ['SYNC_REFUND_STATUS'], tier: 'AUTO', finalCase: 'RESOLVED' },
  { scenario: 'refund_never_initiated', types: ['INITIATE_REFUND'], tier: 'MANAGER', approver: manager, finalCase: 'RESOLVED' },
  { scenario: 'settlement_mismatch', types: ['RAISE_SETTLEMENT_DISPUTE'], tier: 'OPS', approver: ops2, finalCase: 'RESOLVED' },
  { scenario: 'duplicate_capture', types: ['INITIATE_REFUND'], tier: 'OPS', approver: ops2, finalCase: 'RESOLVED' },
  { scenario: 'suspicious_payment', types: ['HOLD_PAYMENT_FOR_REVIEW', 'ESCALATE_TO_HUMAN'], tier: 'MANAGER', approver: manager, finalCase: 'ESCALATED' },
];

describe('manual resolution of every MVP scenario', () => {
  for (const e of EXPECTED) {
    it(`${e.scenario}: ${e.types.join(' + ')} at ${e.tier} → PASS`, async () => {
      const caseId = await openCase(e.scenario);
      const actions = await recommended(caseId);
      expect(actions.map((a) => a.type)).toEqual(e.types);

      const preview = await core.resolutions.preview(caseId, actions, ops);
      expect(preview.preconditionFailures).toEqual([]);
      expect(preview.decision.tier).toBe(e.tier);

      let resolution = await core.resolutions.propose(caseId, { actions, rationale: `Manual fix for ${e.scenario}` }, ops);
      expect(resolution.policy.tier).toBe(e.tier);
      if (e.approver) {
        expect(resolution.status).toBe('AWAITING_APPROVAL');
        const detail = await core.cases.get(caseId, ops);
        expect(detail.status).toBe('AWAITING_APPROVAL');
        expect(detail.resolutionView.canPropose).toBe(false);
        const approvalId = detail.resolutionView.pendingApprovalId!;
        const decided = await core.approvals.decide(approvalId, { decision: 'APPROVE', comment: '' }, e.approver);
        expect(decided.status).toBe('APPROVED');
        resolution = await core.resolutionQueries.item(resolution.id);
      }
      expect(resolution.executions.map((s) => s.status)).toEqual(e.types.map(() => 'SUCCEEDED'));
      expect(resolution.validation?.checks.filter((c) => !c.pass)).toEqual([]);
      expect(resolution.validation?.verdict).toBe('PASS');
      expect(resolution.status).toBe('VALIDATED');

      const detail = await core.cases.get(caseId, ops);
      expect(detail.status).toBe(e.finalCase);
      if (e.finalCase === 'RESOLVED') expect(detail.resolution?.by).toBe('USER');

      // After PASS, a full sweep opens nothing new and the case is not re-flagged.
      const sweep = await core.reconciliation.sweep();
      expect(sweep.opened).toBe(0);
      const all = await core.cases.list({ scope: 'all', limit: 50 });
      expect(all.items).toHaveLength(1);
    });
  }
});

describe('replay_fails_then_replan', () => {
  it('attempt 1 replay FAILs on HTTP 409, attempt 2 mark paid + ledger passes with OPS approval', async () => {
    const caseId = await openCase('replay_fails_then_replan');
    const detail0 = await core.cases.get(caseId, ops);
    const replay = detail0.resolutionView.actionOptions.find((o) => o.type === 'REPLAY_WEBHOOK_EVENT')!;
    expect(replay.available).toBe(true);

    const first = await core.resolutions.propose(caseId, { actions: [replay.action], rationale: 'Replay the failed webhook' }, ops);
    expect(first.policy.tier).toBe('AUTO');
    expect(first.executions[0]?.status).toBe('SUCCEEDED');
    expect(first.executions[0]?.summary).toContain('HTTP 409');
    expect(first.validation?.verdict).toBe('FAIL');
    const delivery = first.validation!.checks.find((c) => c.id === 'a0.webhook.delivery')!;
    expect(delivery).toMatchObject({ pass: false, actual: 'HTTP 409, FAILED' });

    const detail1 = await core.cases.get(caseId, ops);
    expect(detail1.status).toBe('OPEN');
    expect(detail1.matrix.cells.ORDER.status).toBe('FAILED');

    const actions = detail1.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    expect(actions.map((a) => a.type)).toEqual(['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY']);
    const second = await core.resolutions.propose(caseId, { actions, rationale: 'Replay was rejected; correct records directly' }, ops);
    expect(second).toMatchObject({ attempt: 2, status: 'AWAITING_APPROVAL' });
    expect(second.policy.tier).toBe('OPS');
    expect(second.policy.reasons.map((r) => r.ruleId)).toEqual(['P6', 'P7']);

    const approval = (await core.approvals.list({ scope: 'pending', limit: 10 }, ops2)).items[0]!;
    expect(approval.canDecide).toBe(true);
    await core.approvals.decide(approval.id, { decision: 'APPROVE', comment: 'ok' }, ops2);
    const done = await core.resolutionQueries.item(second.id);
    expect(done.validation?.verdict).toBe('PASS');
    expect((await core.cases.get(caseId, ops)).status).toBe('RESOLVED');
  });
});

describe('safety', () => {
  it('executing the same resolution twice posts one ledger journal', async () => {
    const caseId = await openCase('replay_fails_then_replan', 3);
    const detail = await core.cases.get(caseId, ops);
    const actions = ['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY'].map((type) => detail.resolutionView.actionOptions.find((o) => o.type === type)!.action);
    // First attempt, state corrections with a verified capture: AUTO, so it executes right away.
    const r = await core.resolutions.propose(caseId, { actions, rationale: 'Correct records directly' }, ops);
    expect(r.policy.tier).toBe('AUTO');
    expect(r.validation?.verdict).toBe('PASS');
    const again = await core.executor.execute(r.id, { actor: { actorType: 'USER', actorId: ops2.id, actorName: ops2.name } });
    expect(again.ok).toBe(true);
    const paymentId = detail.entityRefs.paymentId!;
    const journals = await core.ledger.journalsForPayment(t.db, paymentId);
    expect(journals.filter((j) => j.kind === 'CAPTURE')).toHaveLength(1);
    const rows = await t.db.select().from(tables.executions).where(eq(tables.executions.resolutionId, r.id));
    expect(rows).toHaveLength(2);
  });

  it('OPS cannot approve MANAGER tier and the requester cannot approve their own request', async () => {
    const caseId = await openCase('refund_never_initiated');
    const actions = await recommended(caseId);
    await core.resolutions.propose(caseId, { actions, rationale: 'Refund the cancelled booking' }, manager);
    const approvalId = (await core.cases.get(caseId, ops)).resolutionView.pendingApprovalId!;

    const asOps = await core.approvals.get(approvalId, ops);
    expect(asOps).toMatchObject({ canDecide: false, cannotDecideReason: 'Needs a manager.' });
    await expect(core.approvals.decide(approvalId, { decision: 'APPROVE', comment: '' }, ops)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const asSelf = await core.approvals.get(approvalId, manager);
    expect(asSelf.canDecide).toBe(false);
    await expect(core.approvals.decide(approvalId, { decision: 'APPROVE', comment: '' }, manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a second proposal while one is pending, and a viewer cannot propose', async () => {
    const caseId = await openCase('duplicate_capture');
    const actions = await recommended(caseId);
    await expect(core.resolutions.propose(caseId, { actions, rationale: 'Refund the duplicate' }, viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await core.cases.get(caseId, viewer)).resolutionView).toMatchObject({ canPropose: false });
    await core.resolutions.propose(caseId, { actions, rationale: 'Refund the duplicate' }, ops);
    await expect(core.resolutions.propose(caseId, { actions, rationale: 'Refund the duplicate' }, ops)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await core.overview.metrics()).awaitingApproval).toBe(1);
  });

  it('reject returns the case to OPEN; escalate marks it ESCALATED', async () => {
    const caseId = await openCase('duplicate_capture', 2);
    const actions = await recommended(caseId);
    await core.resolutions.propose(caseId, { actions, rationale: 'Refund the duplicate' }, ops);
    let approvalId = (await core.cases.get(caseId, ops)).resolutionView.pendingApprovalId!;
    await core.approvals.decide(approvalId, { decision: 'REJECT', comment: 'Check with merchant first' }, ops2);
    expect((await core.cases.get(caseId, ops)).status).toBe('OPEN');
    await core.resolutions.propose(caseId, { actions, rationale: 'Merchant confirmed the duplicate' }, ops);
    approvalId = (await core.cases.get(caseId, ops)).resolutionView.pendingApprovalId!;
    await core.approvals.decide(approvalId, { decision: 'ESCALATE', comment: 'Needs finance sign-off' }, ops2);
    const detail = await core.cases.get(caseId, ops);
    expect(detail.status).toBe('ESCALATED');
    expect(detail.resolutionView.resolutions.map((r) => r.status)).toEqual(['ESCALATED', 'REJECTED']);
  });

  it('blocks a proposal whose preconditions fail and stores it as BLOCKED', async () => {
    const caseId = await openCase('captured_order_failed');
    const bad: CatalogAction = { type: 'POST_LEDGER_ENTRY', params: { paymentId: 'pay_unknown', amountMinor: 100 } };
    const err = await core.resolutions.propose(caseId, { actions: [bad], rationale: 'Post the wrong thing' }, ops).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    const details = (err as AppError).details as { policy: { tier: string }; preconditionFailures: unknown[] };
    expect(details.policy.tier).toBe('BLOCKED');
    expect(details.preconditionFailures).toHaveLength(1);
    const detail = await core.cases.get(caseId, ops);
    expect(detail.resolutionView.resolutions[0]?.status).toBe('BLOCKED');
    expect(detail.status).toBe('OPEN');
  });

  it('the audit log shows the full chain for a resolved case', async () => {
    const caseId = await openCase('refund_never_initiated', 4);
    const actions = await recommended(caseId);
    await core.resolutions.propose(caseId, { actions, rationale: 'Refund the cancelled booking' }, ops);
    const approvalId = (await core.cases.get(caseId, ops)).resolutionView.pendingApprovalId!;
    await core.approvals.decide(approvalId, { decision: 'APPROVE', comment: 'Airline cancelled' }, manager);
    const audit = await core.audit.list({ caseId, limit: 100 });
    const chain = new Set(audit.items.map((a) => a.action));
    for (const action of [
      'case.opened',
      'resolution.proposed',
      'approval.requested',
      'case.awaiting_approval',
      'approval.decided',
      'case.executing',
      'refund.requested',
      'action.executed',
      'resolution.validated',
      'case.resolved',
    ]) {
      expect(chain, action).toContain(action);
    }
    const actors = new Set(audit.items.map((a) => a.actor.name));
    expect(actors).toContain('Ananya Rao');
    expect(actors).toContain('Meera Iyer');
  });
});
