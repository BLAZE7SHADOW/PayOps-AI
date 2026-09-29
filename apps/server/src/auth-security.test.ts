import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import type { MfaSetupResponse, SecurityOverview, SessionUser } from '@payops/shared';
import { createCore, createLogger, loadServerEnv, tables, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import type { PgBoss } from 'pg-boss';
import { createApp } from './app';
import { seedDemoUsers } from './auth/demo-users';
import { RateLimiter } from './auth/rate-limit';
import { SESSION_COOKIE } from './auth/session';
import { totpCode } from './auth/totp';

let t: TestDatabase;
let core: Core;
let app: Express;
const clock = fixedClock('2026-09-28T12:00:00.000Z');
type Agent = ReturnType<typeof request.agent>;

const now = () => clock.now().getTime();
const json = { 'Content-Type': 'application/json' };

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
  clock.set('2026-09-28T12:00:00.000Z');
  // Every test starts with nobody enrolled and nobody signed in.
  await t.db.update(tables.sessions).set({ revokedAt: new Date() });
  await t.db.update(tables.users).set({ totpSecretSealed: null, totpEnabledAt: null, totpLastStep: null });
  await t.db.delete(tables.authRateLimits);
});

async function signIn(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/demo-login').send({ email }).expect(200);
  return agent;
}
const security = async (a: Agent) => (await a.get('/api/auth/security').expect(200)).body as SecurityOverview;

/** Turns MFA on for a signed-in agent; returns the seed so the test can produce codes. */
async function enrol(a: Agent): Promise<string> {
  const { secret } = (await a.post('/api/auth/mfa/setup').set(json).expect(200)).body as MfaSetupResponse;
  await a.post('/api/auth/mfa/enable').send({ code: totpCode(secret, now()) }).expect(200);
  clock.advance(30_000); // the enrolment code is used up; the next one is a new step
  await t.db.delete(tables.authRateLimits); // enrolling counts as a code attempt; start each test with a clean allowance
  return secret;
}

describe('sessions', () => {
  it('lists the signed-in session and marks the current one', async () => {
    const a = await signIn('ops@payops.dev');
    const list = (await security(a)).sessions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ current: true, mfaVerified: false });
  });

  it('logout revokes the session on the server, so a copied cookie stops working', async () => {
    const res = await request(app).post('/api/auth/demo-login').send({ email: 'ops@payops.dev' }).expect(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    await request(app).post('/api/auth/logout').set('Cookie', cookie).set(json).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('an expired session is refused even though the cookie signature is still valid', async () => {
    const a = await signIn('ops@payops.dev');
    await a.get('/api/auth/me').expect(200);
    clock.advance(9 * 60 * 60 * 1000);
    await a.get('/api/auth/me').expect(401);
  });

  it('revokes one other session and leaves the current one', async () => {
    const laptop = await signIn('ops@payops.dev');
    const phone = await signIn('ops@payops.dev');
    const other = (await security(laptop)).sessions.find((s) => !s.current)!;
    await laptop.post(`/api/auth/sessions/${other.id}/revoke`).set(json).expect(200);
    await phone.get('/api/auth/me').expect(401);
    await laptop.get('/api/auth/me').expect(200);
  });

  it('signs out every other session in one call', async () => {
    const a = await signIn('ops@payops.dev');
    const b = await signIn('ops@payops.dev');
    const c = await signIn('ops@payops.dev');
    const res = await a.post('/api/auth/sessions/revoke-others').set(json).expect(200);
    expect(res.body).toEqual({ revoked: 2 });
    await b.get('/api/auth/me').expect(401);
    await c.get('/api/auth/me').expect(401);
    await a.get('/api/auth/me').expect(200);
  });

  it("someone else's session looks missing to an analyst, and an admin can revoke it", async () => {
    const ops = await signIn('ops@payops.dev');
    const viewer = await signIn('viewer@payops.dev');
    const admin = await signIn('admin@payops.dev');
    const viewerSession = (await security(viewer)).sessions[0]!;
    await ops.post(`/api/auth/sessions/${viewerSession.id}/revoke`).set(json).expect(404);
    await viewer.get('/api/auth/me').expect(200);
    await admin.post(`/api/auth/sessions/${viewerSession.id}/revoke`).set(json).expect(200);
    await viewer.get('/api/auth/me').expect(401);
  });

  it('an admin can sign a user out everywhere; an analyst cannot', async () => {
    const ops = await signIn('ops@payops.dev');
    const other = await signIn('ops2@payops.dev');
    const admin = await signIn('admin@payops.dev');
    const [target] = await t.db.select().from(tables.users).where(eq(tables.users.email, 'ops2@payops.dev'));
    await ops.post(`/api/auth/users/${target!.id}/sessions/revoke`).set(json).expect(403);
    await other.get('/api/auth/me').expect(200);
    const res = await admin.post(`/api/auth/users/${target!.id}/sessions/revoke`).set(json).expect(200);
    expect(res.body).toEqual({ revoked: 1 });
    await other.get('/api/auth/me').expect(401);
  });

  it('a role change applies on the next request, not at the next sign-in', async () => {
    const a = await signIn('viewer@payops.dev');
    expect(((await a.get('/api/auth/me').expect(200)).body as SessionUser).role).toBe('VIEWER');
    await t.db.update(tables.users).set({ role: 'OPS' }).where(eq(tables.users.email, 'viewer@payops.dev'));
    try {
      expect(((await a.get('/api/auth/me').expect(200)).body as SessionUser).role).toBe('OPS');
    } finally {
      await t.db.update(tables.users).set({ role: 'VIEWER' }).where(eq(tables.users.email, 'viewer@payops.dev'));
    }
  });

  it('refuses a forged or garbage cookie', async () => {
    await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=forged.token.value`).expect(401);
  });
});

describe('MFA enrolment', () => {
  it('shows MFA as off, and recommended only for manager and admin', async () => {
    expect(await security(await signIn('ops@payops.dev'))).toMatchObject({ mfaEnabled: false, mfaRecommended: false });
    expect(await security(await signIn('manager@payops.dev'))).toMatchObject({ mfaEnabled: false, mfaRecommended: true });
    expect(await security(await signIn('admin@payops.dev'))).toMatchObject({ mfaRecommended: true });
  });

  it('needs a sign-in for every MFA and session route', async () => {
    for (const path of ['/mfa/setup', '/mfa/enable', '/mfa/disable', '/sessions/revoke-others']) {
      await request(app).post(`/api/auth${path}`).set(json).send({ code: '123456' }).expect(401);
    }
    await request(app).get('/api/auth/security').expect(401);
  });

  it('setup returns a seed and an otpauth link, and stores the seed encrypted', async () => {
    const a = await signIn('manager@payops.dev');
    const setup = (await a.post('/api/auth/mfa/setup').set(json).expect(200)).body as MfaSetupResponse;
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    const [row] = await t.db.select().from(tables.users).where(eq(tables.users.email, 'manager@payops.dev'));
    expect(row!.totpSecretSealed).toBeTruthy();
    expect(row!.totpSecretSealed).not.toContain(setup.secret);
    expect(row!.totpEnabledAt).toBeNull();
    // Not on until a code is confirmed: sign-in still needs only the password.
    expect((await security(a)).mfaEnabled).toBe(false);
  });

  it('refuses a wrong code and turns on only after a correct one', async () => {
    const a = await signIn('manager@payops.dev');
    const { secret } = (await a.post('/api/auth/mfa/setup').set(json).expect(200)).body as MfaSetupResponse;
    await a.post('/api/auth/mfa/enable').send({ code: '000000' }).expect(422);
    expect((await security(a)).mfaEnabled).toBe(false);
    await a.post('/api/auth/mfa/enable').send({ code: totpCode(secret, now()) }).expect(200);
    expect((await security(a)).mfaEnabled).toBe(true);
  });

  it('enable without setup, and setup while already on, are conflicts', async () => {
    const a = await signIn('manager@payops.dev');
    await a.post('/api/auth/mfa/enable').send({ code: '123456' }).expect(409);
    await enrol(a);
    await a.post('/api/auth/mfa/setup').set(json).expect(409);
  });

  it('signs out other browsers when MFA is switched on, keeping the current one', async () => {
    const here = await signIn('manager@payops.dev');
    const elsewhere = await signIn('manager@payops.dev');
    await enrol(here);
    await elsewhere.get('/api/auth/me').expect(401);
    await here.get('/api/auth/me').expect(200);
  });

  it('writes audit events for turning MFA on and off', async () => {
    const a = await signIn('manager@payops.dev');
    const secret = await enrol(a);
    await a.post('/api/auth/mfa/disable').send({ code: totpCode(secret, now()) }).expect(200);
    const actions = (await t.db.select({ action: tables.auditEvents.action }).from(tables.auditEvents)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.mfa_enabled', 'auth.mfa_disabled']));
  });
});

describe('sign in with a code', () => {
  it('asks for a code after the password and gives no session until it is right', async () => {
    const a = await signIn('manager@payops.dev');
    const secret = await enrol(a);

    const agent = request.agent(app);
    const step1 = await agent.post('/api/auth/login').send({ email: 'manager@payops.dev', password: 'payops-demo' }).expect(200);
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect(step1.headers['set-cookie']).toBeUndefined();
    await agent.get('/api/auth/me').expect(401);

    const challenge = step1.body.challenge as string;
    await agent.post('/api/auth/login/mfa').send({ challenge, code: '000000' }).expect(401);
    await agent.get('/api/auth/me').expect(401);
    const ok = await agent.post('/api/auth/login/mfa').send({ challenge, code: totpCode(secret, now()) }).expect(200);
    expect(ok.body).toMatchObject({ email: 'manager@payops.dev', role: 'MANAGER' });
    await agent.get('/api/auth/me').expect(200);
    expect((await security(agent)).sessions.find((s) => s.current)).toMatchObject({ mfaVerified: true });
  });

  it('a wrong password never reaches the code step', async () => {
    await enrol(await signIn('manager@payops.dev'));
    const res = await request(app).post('/api/auth/login').send({ email: 'manager@payops.dev', password: 'nope' }).expect(401);
    expect(res.body.mfaRequired).toBeUndefined();
  });

  it('demo sign-in also asks for the code once an account has MFA on', async () => {
    await enrol(await signIn('manager@payops.dev'));
    const res = await request(app).post('/api/auth/demo-login').send({ email: 'manager@payops.dev' }).expect(200);
    expect(res.body).toMatchObject({ mfaRequired: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts each code once', async () => {
    const secret = await enrol(await signIn('manager@payops.dev'));
    const code = totpCode(secret, now());
    const first = await request(app).post('/api/auth/demo-login').send({ email: 'manager@payops.dev' });
    await request(app).post('/api/auth/login/mfa').send({ challenge: first.body.challenge, code }).expect(200);
    const second = await request(app).post('/api/auth/demo-login').send({ email: 'manager@payops.dev' });
    await request(app).post('/api/auth/login/mfa').send({ challenge: second.body.challenge, code }).expect(401);
    clock.advance(30_000);
    await request(app).post('/api/auth/login/mfa').send({ challenge: second.body.challenge, code: totpCode(secret, now()) }).expect(200);
  });

  it('a code cannot be used as a cookie, and a session cookie cannot be used as a challenge', async () => {
    const secret = await enrol(await signIn('manager@payops.dev'));
    const step1 = await request(app).post('/api/auth/demo-login').send({ email: 'manager@payops.dev' });
    await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${step1.body.challenge}`).expect(401);
    // A real session token in the challenge field is refused.
    const res = await request(app).post('/api/auth/demo-login').send({ email: 'admin@payops.dev' }).expect(200);
    const sessionToken = decodeURIComponent(String(res.headers['set-cookie']).split(';')[0]!.split('=')[1]!);
    await request(app).post('/api/auth/login/mfa').send({ challenge: sessionToken, code: totpCode(secret, now()) }).expect(401);
  });

  it('stops guessing: five wrong codes, then even the right code is refused for a while', async () => {
    const secret = await enrol(await signIn('manager@payops.dev'));
    const { body } = await request(app).post('/api/auth/demo-login').send({ email: 'manager@payops.dev' });
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login/mfa').send({ challenge: body.challenge, code: '000000' }).expect(401);
    const blocked = await request(app).post('/api/auth/login/mfa').send({ challenge: body.challenge, code: totpCode(secret, now()) }).expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    clock.advance(6 * 60_000);
    await request(app).post('/api/auth/login/mfa').send({ challenge: body.challenge, code: totpCode(secret, now()) }).expect(200);
  });

  it('turning MFA off needs a valid code and lets password-only sign-in work again', async () => {
    const a = await signIn('manager@payops.dev');
    const secret = await enrol(a);
    await a.post('/api/auth/mfa/disable').send({ code: '000000' }).expect(422);
    await a.post('/api/auth/mfa/disable').send({ code: totpCode(secret, now()) }).expect(200);
    const res = await request(app).post('/api/auth/login').send({ email: 'manager@payops.dev', password: 'payops-demo' }).expect(200);
    expect(res.body).toMatchObject({ email: 'manager@payops.dev' });
  });

  it('an admin can reset a lost device: MFA off and every session of that user ended', async () => {
    const manager = await signIn('manager@payops.dev');
    await enrol(manager);
    const admin = await signIn('admin@payops.dev');
    const [target] = await t.db.select().from(tables.users).where(eq(tables.users.email, 'manager@payops.dev'));
    await manager.post(`/api/auth/users/${target!.id}/mfa/reset`).set(json).expect(403);
    await admin.post(`/api/auth/users/${target!.id}/mfa/reset`).set(json).expect(200);
    await manager.get('/api/auth/me').expect(401);
    const res = await request(app).post('/api/auth/login').send({ email: 'manager@payops.dev', password: 'payops-demo' }).expect(200);
    expect(res.body.mfaRequired).toBeUndefined();
    await admin.post('/api/auth/users/missing/mfa/reset').set(json).expect(404);
  });
});

describe('persistent rate limiter', () => {
  it('blocks after the limit, starts a new window later, and counts keys separately', async () => {
    const limiter = new RateLimiter(t.db, clock);
    const hit = (key: string) => limiter.hit(key, 3, 60_000, 'slow down');
    for (let i = 0; i < 3; i++) await hit('a');
    await expect(hit('a')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await hit('b');
    clock.advance(60_001);
    await hit('a');
  });

  it('keeps counting across a new instance, as after a server restart', async () => {
    const before = new RateLimiter(t.db, clock);
    for (let i = 0; i < 3; i++) await before.hit('restart', 3, 60_000, 'slow down');
    const after = new RateLimiter(t.db, clock);
    await expect(after.hit('restart', 3, 60_000, 'slow down')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('clear forgets a key and purgeExpired removes finished windows', async () => {
    const limiter = new RateLimiter(t.db, clock);
    for (let i = 0; i < 3; i++) await limiter.hit('k', 3, 60_000, 'slow down');
    await limiter.clear('k');
    await limiter.hit('k', 3, 60_000, 'slow down');
    clock.advance(120_000);
    await limiter.purgeExpired();
    expect(await t.db.select().from(tables.authRateLimits)).toEqual([]);
  });

  it('is the limit behind sign-in: eleven attempts in a minute get a 429', async () => {
    for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').send({ email: 'viewer@payops.dev', password: 'bad' });
    await request(app).post('/api/auth/login').send({ email: 'viewer@payops.dev', password: 'payops-demo' }).expect(429);
  });
});
