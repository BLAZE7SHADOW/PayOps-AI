import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type {
  ApprovalDetail,
  ApprovalItem,
  CaseDetail,
  DemoAccount,
  GenerateScenarioResult,
  Page,
  PolicyDocument,
  PolicyPreview,
  ResolutionItem,
  SessionUser,
} from '@payops/shared';
import { createCore, createLogger, loadServerEnv, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import type { PgBoss } from 'pg-boss';
import { createApp } from './app';
import { DEMO_PASSWORD, seedDemoUsers } from './auth/demo-users';
import { hashPassword, verifyPassword } from './auth/password';
import { readCookie } from './auth/session';

let t: TestDatabase;
let core: Core;
let app: Express;
type Agent = ReturnType<typeof request.agent>;

async function signIn(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/demo-login').send({ email }).expect(200);
  return agent;
}

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock: fixedClock('2026-09-28T12:00:00.000Z') });
  const fakeBoss = { send: async () => null } as unknown as PgBoss;
  const env = loadServerEnv({ NODE_ENV: 'test' });
  app = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: fakeBoss });
  await seedDemoUsers(t.db);
});
afterAll(async () => {
  await t.close();
});

describe('passwords', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
  it('reads a cookie from a raw header', () => {
    expect(readCookie('a=1; payops_session=abc%20d; b=2', 'payops_session')).toBe('abc d');
    expect(readCookie(undefined, 'payops_session')).toBeUndefined();
  });
});

describe('auth API', () => {
  it('401s protected routes without a cookie; health is public', async () => {
    await request(app).get('/api/health').expect(200);
    const res = await request(app).get('/api/cases').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/cases').set('Cookie', 'payops_session=not-a-jwt').expect(401);
  });

  it('logs in with a password, sets an httpOnly cookie, and /me returns the user', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email: 'Manager@PayOps.dev', password: DEMO_PASSWORD }).expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/payops_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = (await agent.get('/api/auth/me').expect(200)).body as SessionUser;
    expect(me).toMatchObject({ email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER' });
    await agent.post('/api/auth/logout').set('Content-Type', 'application/json').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects bad credentials with one generic message', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'ops@payops.dev', password: 'nope' }).expect(401);
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@payops.dev', password: 'nope' }).expect(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('rate limits repeated sign-in attempts per IP and email', async () => {
    for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').send({ email: 'viewer@payops.dev', password: 'bad' });
    const res = await request(app).post('/api/auth/login').send({ email: 'viewer@payops.dev', password: DEMO_PASSWORD }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('demo login works only for demo accounts, and lists them', async () => {
    const accounts = (await request(app).get('/api/auth/demo-accounts').expect(200)).body as DemoAccount[];
    expect(accounts.map((a) => a.label)).toEqual(['Ops analyst', 'Second ops analyst', 'Ops manager', 'Viewer', 'Admin']);
    await request(app).post('/api/auth/demo-login').send({ email: 'someone@else.com' }).expect(401);
    const agent = await signIn('viewer@payops.dev');
    expect(((await agent.get('/api/auth/me').expect(200)).body as SessionUser).role).toBe('VIEWER');
  });

  it('CSRF: rejects state-changing requests that are not JSON', async () => {
    const agent = await signIn('ops@payops.dev');
    const res = await agent.post('/api/simulator/reset').set('Content-Type', 'text/plain').send('x').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    await agent.post('/api/auth/logout').type('form').send({ a: 1 }).expect(415);
  });
});

describe('resolution API', () => {
  let ops: Agent;
  let ops2: Agent;
  let manager: Agent;
  let viewer: Agent;

  beforeAll(async () => {
    ops = await signIn('ops@payops.dev');
    ops2 = await signIn('ops2@payops.dev');
    manager = await signIn('manager@payops.dev');
    viewer = await signIn('viewer@payops.dev');
    await ops.post('/api/simulator/reset').send({}).expect(200);
  });

  const generate = async (scenario: string, seed: number) =>
    ((await ops.post('/api/simulator/scenarios').send({ scenario, seed }).expect(201)).body as GenerateScenarioResult).casesOpened[0]!.id;

  it('viewers can read cases but get 403 proposing or using the simulator', async () => {
    const caseId = await generate('captured_order_failed', 11);
    const detail = (await viewer.get(`/api/cases/${caseId}`).expect(200)).body as CaseDetail;
    expect(detail.resolutionView).toMatchObject({ canPropose: false });
    const actions = detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    const res = await viewer.post(`/api/cases/${caseId}/actions`).send({ actions, rationale: 'Viewer should not do this' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await viewer.post('/api/simulator/scenarios').send({ scenario: 'healthy_payment' }).expect(403);
  });

  it('previews and proposes an AUTO fix that validates PASS', async () => {
    const caseId = await generate('captured_order_failed', 12);
    const detail = (await ops.get(`/api/cases/${caseId}`).expect(200)).body as CaseDetail;
    expect(detail.resolutionView.canPropose).toBe(true);
    const actions = detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    const preview = (await ops.post(`/api/cases/${caseId}/actions/preview`).send({ actions }).expect(200)).body as PolicyPreview;
    expect(preview).toMatchObject({ attempt: 1, approverHint: null, preconditionFailures: [] });
    expect(preview.decision.tier).toBe('AUTO');
    const created = (await ops.post(`/api/cases/${caseId}/actions`).send({ actions, rationale: 'Replay the failed webhook' }).expect(201)).body as ResolutionItem;
    expect(created.validation?.verdict).toBe('PASS');
    expect(((await ops.get(`/api/cases/${caseId}`).expect(200)).body as CaseDetail).status).toBe('RESOLVED');
  });

  it('runs the approval flow: four-eyes, manager tier, then PASS', async () => {
    const caseId = await generate('refund_never_initiated', 13);
    const detail = (await ops.get(`/api/cases/${caseId}`).expect(200)).body as CaseDetail;
    const actions = detail.resolutionView.actionOptions.filter((o) => o.recommended).map((o) => o.action);
    const created = (await ops.post(`/api/cases/${caseId}/actions`).send({ actions, rationale: 'Refund the cancelled booking' }).expect(201)).body as ResolutionItem;
    expect(created).toMatchObject({ status: 'AWAITING_APPROVAL', policy: { tier: 'MANAGER' } });

    const page = (await ops2.get('/api/approvals').expect(200)).body as Page<ApprovalItem>;
    const item = page.items.find((a) => a.case.id === caseId)!;
    expect(item).toMatchObject({ tier: 'MANAGER', canDecide: false, cannotDecideReason: 'Needs a manager.', actionsSummary: 'Refund customer ₹78,000.00' });
    await ops2.post(`/api/approvals/${item.id}/decision`).send({ decision: 'APPROVE' }).expect(403);
    await ops.post(`/api/approvals/${item.id}/decision`).send({ decision: 'APPROVE' }).expect(403);
    await manager.post(`/api/approvals/${item.id}/decision`).send({ decision: 'REJECT', comment: 'no' }).expect(422);

    const asManager = (await manager.get(`/api/approvals/${item.id}`).expect(200)).body as ApprovalDetail;
    expect(asManager.canDecide).toBe(true);
    expect(asManager.resolution.id).toBe(created.id);
    const decided = (await manager.post(`/api/approvals/${item.id}/decision`).send({ decision: 'APPROVE', comment: 'Airline cancelled' }).expect(200)).body as ApprovalItem;
    expect(decided).toMatchObject({ status: 'APPROVED', canDecide: false });
    await manager.post(`/api/approvals/${item.id}/decision`).send({ decision: 'APPROVE' }).expect(409);

    const after = (await ops.get(`/api/cases/${caseId}`).expect(200)).body as CaseDetail;
    expect(after.status).toBe('RESOLVED');
    expect(after.resolutionView.resolutions[0]?.validation?.verdict).toBe('PASS');
  });

  it('422s a blocked proposal with policy and precondition details', async () => {
    const caseId = await generate('captured_order_failed', 14);
    const res = await ops
      .post(`/api/cases/${caseId}/actions`)
      .send({ actions: [{ type: 'SYNC_REFUND_STATUS', params: { refundId: 'rfd_nope' } }], rationale: 'This refund does not exist' })
      .expect(422);
    expect(res.body.error.details.policy.tier).toBe('BLOCKED');
    expect(res.body.error.details.preconditionFailures[0].message).toBe('Refund rfd_nope is not on this case.');
    await ops.post(`/api/cases/${caseId}/actions`).send({ actions: [], rationale: 'too short' }).expect(422);
  });

  it('serves the policy document', async () => {
    const doc = (await viewer.get('/api/policy').expect(200)).body as PolicyDocument;
    expect(doc.rules).toHaveLength(13);
    expect(doc.thresholds[0]).toEqual({ label: 'Refunds approved automatically up to', value: '₹1,000.00' });
  });
});
