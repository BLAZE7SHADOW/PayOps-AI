import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { DemoLoginBody, LoginBody, type DemoAccount, type SessionUser } from '@payops/shared';
import { AppError, tables, type Core, type ServerEnv } from '@payops/core';
import { DEMO_ACCOUNTS, isDemoEmail } from '../auth/demo-users';
import { rateLimiter } from '../auth/middleware';
import { verifyPassword } from '../auth/password';
import { SESSION_COOKIE, cookieOptions, signSession, type SessionConfig } from '../auth/session';
import { parseBody } from '../lib/validate';

const BAD_CREDENTIALS = 'Email or password is incorrect';

export function authRoutes(core: Core, env: Pick<ServerEnv, 'DEMO_MODE'>, session: SessionConfig): Router {
  const router = Router();
  const limiter = rateLimiter(10, 60_000);

  const findUser = async (email: string) => {
    const [row] = await core.db.select().from(tables.users).where(eq(tables.users.email, email)).limit(1);
    return row ?? null;
  };

  const startSession = async (res: Response, user: SessionUser) => {
    res.cookie(SESSION_COOKIE, await signSession(user, session), cookieOptions(session));
    res.json(user);
  };

  router.post('/login', async (req, res) => {
    const body = parseBody(LoginBody, req);
    limiter.check(`${req.ip ?? 'unknown'}|${body.email}`);
    const user = await findUser(body.email);
    // Same message and a real hash check either way, so the response does not reveal which emails exist.
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : await verifyPassword(body.password, 'scrypt$AAAA$AAAA');
    if (!user || !ok) throw new AppError('UNAUTHENTICATED', BAD_CREDENTIALS);
    await startSession(res, { id: user.id, email: user.email, name: user.name, role: user.role });
  });

  router.post('/demo-login', async (req, res) => {
    if (!env.DEMO_MODE) throw new AppError('NOT_FOUND', 'Demo sign-in is disabled');
    const body = parseBody(DemoLoginBody, req);
    const user = isDemoEmail(body.email) ? await findUser(body.email) : null;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Not a demo account');
    await startSession(res, { id: user.id, email: user.email, name: user.name, role: user.role });
  });

  router.post('/logout', (_req, res) => {
    const { maxAge: _maxAge, ...opts } = cookieOptions(session);
    res.clearCookie(SESSION_COOKIE, opts);
    res.json({ status: 'ok' });
  });

  router.get('/me', (req, res) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Not signed in');
    const body: SessionUser = req.user;
    res.json(body);
  });

  router.get('/demo-accounts', (_req, res) => {
    const body: readonly DemoAccount[] = env.DEMO_MODE ? DEMO_ACCOUNTS : [];
    res.json(body);
  });

  return router;
}
