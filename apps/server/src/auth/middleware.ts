import type { RequestHandler } from 'express';
import { roleAtLeast, roleFor, type Permission, type Role, type SessionUser } from '@payops/shared';
import { AppError } from '@payops/core';
import { SESSION_COOKIE, verifySession, type SessionConfig } from './session';
import type { ActiveSession, SessionStore } from './session-store';

/** Cookie signature first (cheap), then the sessions table. Null for anything not live. */
export async function resolveSession(token: string | undefined, config: SessionConfig, store: SessionStore): Promise<ActiveSession | null> {
  const claims = await verifySession(token, config);
  return claims ? store.resolve(claims.sessionId, claims.user.id) : null;
}

/**
 * Reads the session cookie on every request and sets req.user when it is valid and the session is
 * still live in the database. Never rejects; requirePermission does that.
 */
export function readSession(config: SessionConfig, store: SessionStore): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
      const active = await resolveSession(token, config, store);
      req.user = active?.user;
      req.sessionId = active?.id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Marker read by the route-coverage test: which permission (or 'public') a handler stands for. */
export const GUARD = Symbol('payops.guard');
type Guarded = RequestHandler & { [GUARD]?: Permission | 'public' };

/**
 * 401 without a valid session, 403 when the role is below the one the permission table names.
 * `roleOverride` exists for the simulator, whose rule depends on DEMO_MODE (see PERMISSIONS).
 */
export function requirePermission(permission: Permission, opts: { roleOverride?: Role } = {}): RequestHandler {
  const needed = opts.roleOverride ?? roleFor(permission);
  const handler: Guarded = (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
    if (!roleAtLeast(req.user.role, needed)) return next(new AppError('FORBIDDEN', `This needs the ${needed} role or above`));
    next();
  };
  handler[GUARD] = permission;
  return handler;
}

/** Explicitly open route (sign-in, health). Does nothing at runtime; it makes "no guard" a visible choice. */
export function publicRoute(): RequestHandler {
  const handler: Guarded = (_req, _res, next) => next();
  handler[GUARD] = 'public';
  return handler;
}

/** The signed-in user; only call behind requirePermission. */
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
