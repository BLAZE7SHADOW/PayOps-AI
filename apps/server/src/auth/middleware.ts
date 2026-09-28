import type { RequestHandler } from 'express';
import { roleAtLeast, type Role, type SessionUser } from '@payops/shared';
import { AppError } from '@payops/core';
import { SESSION_COOKIE, verifySession, type SessionConfig } from './session';

/** Reads the session cookie on every request and sets req.user when it is valid. Never rejects. */
export function readSession(config: SessionConfig): RequestHandler {
  return async (req, _res, next) => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    req.user = (await verifySession(token, config)) ?? undefined;
    next();
  };
}

/** 401 without a valid session, 403 when the role is below `role`. */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
    if (!roleAtLeast(req.user.role, role)) return next(new AppError('FORBIDDEN', `This needs the ${role} role or above`));
    next();
  };
}

/** The signed-in user; only call behind requireRole. */
export function sessionUser(req: { user?: SessionUser }): SessionUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  return req.user;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence, together with SameSite=Lax cookies: state-changing requests must be JSON.
 * A cross-site HTML form can only send urlencoded, multipart or text/plain bodies, and a
 * cross-site fetch with a JSON content type needs a CORS preflight our CORS policy refuses.
 */
export function requireJson(): RequestHandler {
  return (req, _res, next) => {
    // Header check rather than req.is(): req.is() returns null for bodiless requests (e.g. logout).
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (STATE_CHANGING.has(req.method) && type !== 'application/json') {
      return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'State-changing requests must send Content-Type: application/json'));
    }
    next();
  };
}

/** Tiny fixed-window limiter, in memory. Enough for one server process. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string, now = Date.now()): void {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        return;
      }
      entry.count += 1;
      if (entry.count > limit) throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
    },
  };
}
