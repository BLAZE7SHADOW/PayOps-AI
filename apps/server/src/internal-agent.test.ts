import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PgBoss } from 'pg-boss';
import { createRunRow, getRunRow, listSteps } from '@payops/agents';
import { createCore, createLogger, loadServerEnv, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { newId } from '@payops/shared';
import { generateScenario } from '@payops/simulator';
import { createApp } from './app';

const SECRET = 'test-agent-secret-0123456789';
let t: TestDatabase;
let core: Core;
let app: Express;
let caseId: string;

const call = (path: string, body: unknown, secret: string | null = SECRET) => {
  const req = request(app).post(`/internal/agent${path}`);
  if (secret) req.set('x-agent-secret', secret);
  return req.send(body as object);
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock: fixedClock('2026-09-28T12:00:00.000Z') });
  const env = loadServerEnv({ NODE_ENV: 'test', AGENT_INTERNAL_SECRET: SECRET });
  app = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: { send: async () => null } as unknown as PgBoss });
  const made = await generateScenario(core, { scenario: 'captured_order_failed', seed: 3201 });
  caseId = made.casesOpened[0]!.id;
});
afterAll(async () => {
  await t.close();
});

describe('internal agent API (D085)', () => {
  it('is closed without the shared secret, or with a wrong one', async () => {
    await call('/case-brief', { caseId }, null).expect(401);
    await call('/case-brief', { caseId }, 'wrong-secret-0123456789').expect(401);
  });

  it('is not mounted when no secret is configured', async () => {
    const env = loadServerEnv({ NODE_ENV: 'test' });
    const closed = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: { send: async () => null } as unknown as PgBoss });
    await request(closed).post('/internal/agent/case-brief').set('x-agent-secret', SECRET).send({ caseId }).expect(404);
  });

  it('returns the code-built case brief and entity refs', async () => {
    const res = await call('/case-brief', { caseId }).expect(200);
    expect(res.body.brief).toMatchObject({ caseId, type: 'PAYMENT_MISMATCH', amountBand: 'HIGH' });
    expect(res.body.entityRefs).toBeDefined();
  });

  it('runs tools in the order asked and keeps their evidence drafts', async () => {
    const res = await call('/tools', { caseId, tools: ['getOrder', 'getGatewayPayment'] }).expect(200);
    expect(res.body.results.map((r: { tool: string }) => r.tool)).toEqual(['getOrder', 'getGatewayPayment']);
    expect(res.body.results[0].drafts[0]).toMatchObject({ source: 'getOrder', system: 'ORDER' });
  });

  it('rejects an unknown tool and a malformed body', async () => {
    await call('/tools', { caseId, tools: ['dropTable'] }).expect(400);
    await call('/tools', { caseId: '' }).expect(422);
  });

  it('records a step and syncs the run row', async () => {
    const runId = newId('run');
    await createRunRow(core, { id: runId, caseId });
    await call('/steps', { runId, caseId, node: 'triage', kind: 'NODE_STARTED', payload: { a: 1 } }).expect(200);
    expect((await listSteps(core, runId)).map((s) => s.node)).toEqual(['triage']);
    await call('/steps', { runId, caseId, node: 'triage', kind: 'NOT_A_KIND', payload: {} }).expect(422);
    await call('/sync', { runId, caseId, interrupted: true, state: { status: 'AWAITING_APPROVAL', attempt: 1, evidence: [], findings: [] } }).expect(200);
    expect((await getRunRow(core, runId))?.status).toBe('AWAITING_APPROVAL');
    await call('/fail', { runId, error: 'boom' }).expect(200);
    expect(await getRunRow(core, runId)).toMatchObject({ status: 'FAILED', error: 'boom' });
  });
});
