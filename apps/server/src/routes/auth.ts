import { Router, type Request, type Response } from 'express';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  DemoLoginBody,
  LoginBody,
  MfaCodeBody,
  MfaLoginBody,
  mfaRecommendedFor,
  type DemoAccount,
  type LoginResponse,
  type MfaSetupResponse,
  type SecurityOverview,
  type SessionUser,
} from '@payops/shared';
import { AppError, tables, type Core, type ServerEnv } from '@payops/core';
import { DEMO_ACCOUNTS, isDemoEmail } from '../auth/demo-users';
import { publicRoute, requirePermission, sessionUser } from '../auth/middleware';
import { verifyPassword } from '../auth/password';
import type { RateLimiter } from '../auth/rate-limit';
import { openSecret, sealSecret } from '../auth/secret-box';
import {
  SESSION_COOKIE,
  cookieOptions,
  signMfaChallenge,
  signSession,
  verifyMfaChallenge,
  type SessionConfig,
} from '../auth/session';
import type { SessionStore } from '../auth/session-store';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp';
import { parseBody } from '../lib/validate';

const BAD_CREDENTIALS = 'Email or password is incorrect';
const BAD_CODE = 'That code is not correct or has already been used';
const TOO_MANY_LOGINS = 'Too many sign-in attempts. Try again in a minute.';
const TOO_MANY_CODES = 'Too many incorrect codes. Try again in a few minutes.';
const ISSUER = 'PayOps AI';

type UserRow = typeof tables.users.$inferSelect;

export interface AuthDeps {
  core: Core;
  env: Pick<ServerEnv, 'DEMO_MODE'>;
  session: SessionConfig;
  sessions: SessionStore;
  limiter: RateLimiter;
}

export function authRoutes({ core, env, session, sessions, limiter }: AuthDeps): Router {
  const router = Router();
  const db = core.db;
  // The TOTP seed is encrypted with a key derived from the same secret that signs cookies.
  const sealKey = Buffer.from(session.key).toString('base64');
  const ip = (req: Request) => req.ip ?? 'unknown';

  const findUser = async (email: string) => {
    const [row] = await db.select().from(tables.users).where(eq(tables.users.email, email)).limit(1);
    return row ?? null;
  };
  const getUser = async (id: string) => {
    const [row] = await db.select().from(tables.users).where(eq(tables.users.id, id)).limit(1);
    return row ?? null;
  };
  const toSessionUser = (u: UserRow): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });
  const actorOf = (u: Pick<SessionUser, 'id' | 'name'>) => ({ actorType: 'USER' as const, actorId: u.id, actorName: u.name });

  /** Creates the session row and the cookie. */
  const startSession = async (req: Request, res: Response, user: UserRow, mfaVerified: boolean) => {
    const { id } = await sessions.create({ userId: user.id, ip: ip(req), userAgent: req.get('user-agent') ?? '', mfaVerified });
    const body: SessionUser = toSessionUser(user);
    res.cookie(SESSION_COOKIE, await signSession(body, id, session), cookieOptions(session));
    res.json(body);
  };

  /** After the password step: sign in, or ask for a one-time code if the user turned MFA on. */
  const afterPassword = async (req: Request, res: Response, user: UserRow) => {
    if (user.totpEnabledAt && user.totpSecretSealed) {
      const body: LoginResponse = { mfaRequired: true, challenge: await signMfaChallenge(user.id, session) };
      res.json(body);
      return;
    }
    await startSession(req, res, user, false);
  };

  /**
   * Checks a code against the user's seed. A code is accepted once: the step it matched is stored
   * with a conditional update, so two requests racing with the same code cannot both succeed.
   * `pending` allows checking the seed of a setup that is not switched on yet.
   */
  const checkCode = async (user: UserRow, code: string, opts: { pending?: boolean } = {}): Promise<boolean> => {
    if (!user.totpSecretSealed || (!opts.pending && !user.totpEnabledAt)) return false;
    const secret = openSecret(user.totpSecretSealed, sealKey);
    if (!secret) return false;
    const step = verifyTotp({ secret, code, nowMs: core.clock.now().getTime(), lastUsedStep: user.totpLastStep });
    if (step === null) return false;
    const claimed = await db
      .update(tables.users)
      .set({ totpLastStep: step })
      .where(and(eq(tables.users.id, user.id), or(isNull(tables.users.totpLastStep), lt(tables.users.totpLastStep, step))))
      .returning({ id: tables.users.id });
    return claimed.length > 0;
  };

  const limitCodes = (userId: string) => limiter.hit(`mfa:${userId}`, 5, 5 * 60_000, TOO_MANY_CODES);

  // ── Sign in ────────────────────────────────────────────────────────────────

  router.post('/login', publicRoute(), async (req, res) => {
    const body = parseBody(LoginBody, req);
    await limiter.hit(`login:${ip(req)}|${body.email}`, 10, 60_000, TOO_MANY_LOGINS);
    const user = await findUser(body.email);
    // Same message and a real hash check either way, so the response does not reveal which emails exist.
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : await verifyPassword(body.password, 'scrypt$AAAA$AAAA');
    if (!user || !ok) throw new AppError('UNAUTHENTICATED', BAD_CREDENTIALS);
    await afterPassword(req, res, user);
  });

  router.post('/login/mfa', publicRoute(), async (req, res) => {
    const body = parseBody(MfaLoginBody, req);
    const userId = await verifyMfaChallenge(body.challenge, session);
    if (!userId) throw new AppError('UNAUTHENTICATED', 'Sign in again: the code step expired');
    await limitCodes(userId);
    const user = await getUser(userId);
    if (!user || !(await checkCode(user, body.code))) throw new AppError('UNAUTHENTICATED', BAD_CODE);
    await limiter.clear(`mfa:${userId}`);
    await startSession(req, res, user, true);
  });

  router.post('/demo-login', publicRoute(), async (req, res) => {
    if (!env.DEMO_MODE) throw new AppError('NOT_FOUND', 'Demo sign-in is disabled');
    const body = parseBody(DemoLoginBody, req);
    const user = isDemoEmail(body.email) ? await findUser(body.email) : null;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Not a demo account');
    // A demo account that turned MFA on is asked for its code like any other account.
    await afterPassword(req, res, user);
  });

  router.post('/logout', publicRoute(), async (req, res) => {
    if (req.sessionId) await sessions.revoke(req.sessionId);
    const { maxAge: _maxAge, ...opts } = cookieOptions(session);
    res.clearCookie(SESSION_COOKIE, opts);
    res.json({ status: 'ok' });
  });

  router.get('/me', publicRoute(), (req, res) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Not signed in');
    const body: SessionUser = req.user;
    res.json(body);
  });

  router.get('/demo-accounts', publicRoute(), (_req, res) => {
    const body: readonly DemoAccount[] = env.DEMO_MODE ? DEMO_ACCOUNTS : [];
    res.json(body);
  });

  // ── MFA enrolment ──────────────────────────────────────────────────────────

  router.get('/security', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const user = await getUser(me.id);
    const body: SecurityOverview = {
      mfaEnabled: Boolean(user?.totpEnabledAt),
      mfaRecommended: mfaRecommendedFor(me.role),
      sessions: await sessions.listActive(me.id, req.sessionId),
    };
    res.json(body);
  });

  router.post('/mfa/setup', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const user = await getUser(me.id);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Not signed in');
    if (user.totpEnabledAt) throw new AppError('CONFLICT', 'MFA is already on. Turn it off first to enrol a new device.');
    // Calling setup again replaces an unconfirmed seed, so a lost QR code is not a dead end.
    const secret = generateTotpSecret();
    await db.update(tables.users).set({ totpSecretSealed: sealSecret(secret, sealKey), totpLastStep: null }).where(eq(tables.users.id, me.id));
    const body: MfaSetupResponse = { secret, otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: ISSUER }) };
    res.json(body);
  });

  router.post('/mfa/enable', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const { code } = parseBody(MfaCodeBody, req);
    await limitCodes(me.id);
    const user = await getUser(me.id);
    if (!user?.totpSecretSealed) throw new AppError('CONFLICT', 'Start MFA setup first');
    if (user.totpEnabledAt) throw new AppError('CONFLICT', 'MFA is already on');
    if (!(await checkCode(user, code, { pending: true }))) throw new AppError('VALIDATION_FAILED', BAD_CODE);
    await db.update(tables.users).set({ totpEnabledAt: core.clock.now() }).where(eq(tables.users.id, me.id));
    // Other browsers signed in without a code are signed out now that a code is required.
    const revoked = await sessions.revokeAllFor(me.id, req.sessionId);
    await core.audit.record({ ...actorOf(me), action: 'auth.mfa_enabled', entityType: 'user', entityId: me.id, summary: `${me.name} turned on MFA (${revoked} other sessions signed out)` });
    res.json({ mfaEnabled: true, otherSessionsRevoked: revoked });
  });

  router.post('/mfa/disable', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const { code } = parseBody(MfaCodeBody, req);
    await limitCodes(me.id);
    const user = await getUser(me.id);
    if (!user?.totpEnabledAt) throw new AppError('CONFLICT', 'MFA is not on');
    if (!(await checkCode(user, code))) throw new AppError('VALIDATION_FAILED', BAD_CODE);
    await clearMfa(me.id);
    await core.audit.record({ ...actorOf(me), action: 'auth.mfa_disabled', entityType: 'user', entityId: me.id, summary: `${me.name} turned off MFA` });
    res.json({ mfaEnabled: false });
  });

  const clearMfa = (userId: string) =>
    db.update(tables.users).set({ totpSecretSealed: null, totpEnabledAt: null, totpLastStep: null }).where(eq(tables.users.id, userId));

  /** Lost phone: an admin switches MFA off for that user and signs them out everywhere. */
  router.post('/users/:id/mfa/reset', requirePermission('user.mfaReset'), async (req, res) => {
    const me = sessionUser(req);
    const id = String(req.params.id);
    const target = await getUser(id);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    await clearMfa(id);
    const revoked = await sessions.revokeAllFor(id);
    await core.audit.record({ ...actorOf(me), action: 'auth.mfa_reset', entityType: 'user', entityId: id, summary: `${me.name} reset MFA for ${target.name} (${revoked} sessions signed out)` });
    res.json({ mfaEnabled: false, sessionsRevoked: revoked });
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  router.post('/sessions/revoke-others', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const revoked = await sessions.revokeAllFor(me.id, req.sessionId);
    if (revoked > 0) await core.audit.record({ ...actorOf(me), action: 'auth.sessions_revoked', entityType: 'user', entityId: me.id, summary: `${me.name} signed out ${revoked} other sessions` });
    res.json({ revoked });
  });

  router.post('/sessions/:id/revoke', requirePermission('account.security'), async (req, res) => {
    const me = sessionUser(req);
    const id = String(req.params.id);
    const owner = await sessions.ownerOf(id);
    // Someone else's session looks like a missing one, so ids cannot be probed.
    if (!owner || (owner !== me.id && me.role !== 'ADMIN')) throw new AppError('NOT_FOUND', 'Session not found');
    const revoked = await sessions.revoke(id);
    if (revoked) await core.audit.record({ ...actorOf(me), action: 'auth.session_revoked', entityType: 'user', entityId: owner, summary: owner === me.id ? `${me.name} signed out a session` : `${me.name} signed out a session of another user` });
    if (id === req.sessionId) {
      const { maxAge: _maxAge, ...opts } = cookieOptions(session);
      res.clearCookie(SESSION_COOKIE, opts);
    }
    res.json({ revoked });
  });

  router.post('/users/:id/sessions/revoke', requirePermission('user.sessionsRevoke'), async (req, res) => {
    const me = sessionUser(req);
    const id = String(req.params.id);
    const target = await getUser(id);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    const revoked = await sessions.revokeAllFor(id);
    await core.audit.record({ ...actorOf(me), action: 'auth.sessions_revoked', entityType: 'user', entityId: id, summary: `${me.name} signed out ${revoked} sessions of ${target.name}` });
    res.json({ revoked });
  });

  return router;
}
