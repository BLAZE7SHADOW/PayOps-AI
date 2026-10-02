import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import type { AuditChainStatus } from '@payops/shared';
import { createCore, createLogger, loadServerEnv, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import type { PgBoss } from 'pg-boss';
import { createApp } from './app';
import { seedDemoUsers } from './auth/demo-users';

let t: TestDatabase;
let core: Core;
let app: Express;
const clock = fixedClock('2026-09-30T09:00:00.000Z');
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
  const env = loadServerEnv({ NODE_ENV: 'test' });
  app = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: { send: async () => null } as unknown as PgBoss });
  await seedDemoUsers(t.db);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.execute(sql`truncate audit_events`);
});

async function signIn(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/demo-login').send({ email }).expect(200);
  return agent;
}

const write = (n: number, summary = `note ${n}`) =>
  core.audit.record({ actorType: 'USER', actorId: 'u1', actorName: 'Ananya', action: 'case.note', entityType: 'case', entityId: 'case_1', summary, caseId: 'case_1' });

describe('audit verify and export routes', () => {
  it('lets a manager verify an intact chain', async () => {
    await write(1);
    await write(2);
    const res = await (await signIn('manager@payops.dev')).get('/api/audit/verify').expect(200);
    const body = res.body as AuditChainStatus;
    expect(body).toMatchObject({ ok: true, checked: 2, reason: null });
    expect(body.head?.seq).toBe(2);
  });

  it('reports the row that was tampered with', async () => {
    await write(1);
    await write(2);
    await t.db.execute(sql`alter table audit_events disable trigger user`);
    await t.db.execute(sql`update audit_events set summary = 'changed' where seq = 1`);
    await t.db.execute(sql`alter table audit_events enable trigger user`);
    const res = await (await signIn('manager@payops.dev')).get('/api/audit/verify').expect(200);
    expect(res.body).toMatchObject({ ok: false, brokenAtSeq: 1, reason: 'HASH_MISMATCH' });
  });

  it('exports CSV with a header, the rows, and a row recording the export', async () => {
    await write(1, '=cmd()');
    const res = await (await signIn('manager@payops.dev')).get('/api/audit/export.csv').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^seq,id,at,/);
    expect(res.text).toContain("'=cmd()");
    expect(res.text).toContain('audit.exported');
  });

  it('keeps both routes away from ops and viewers, and signed-out callers', async () => {
    for (const email of ['ops@payops.dev', 'viewer@payops.dev']) {
      const agent = await signIn(email);
      await agent.get('/api/audit/verify').expect(403);
      await agent.get('/api/audit/export.csv').expect(403);
    }
    await request(app).get('/api/audit/verify').expect(401);
  });
});
