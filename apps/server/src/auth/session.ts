/**
 * Sessions are a signed JWT (HS256, 8 hours) in an httpOnly cookie. Claims carry what the UI
 * and role checks need, so requests do not hit the database to authenticate.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { CookieOptions } from 'express';
import { ROLES, type Role, type SessionUser } from '@payops/shared';
import type { Logger, ServerEnv } from '@payops/core';

export const SESSION_COOKIE = 'payops_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ISSUER = 'payops';

/** Only for local development and tests. Production refuses to start without JWT_SECRET (env.ts). */
const DEV_SECRET = 'payops-dev-secret-do-not-use-in-production';

export interface SessionConfig {
  key: Uint8Array;
  secure: boolean;
}

export function sessionConfig(env: Pick<ServerEnv, 'JWT_SECRET' | 'NODE_ENV'>, log?: Logger): SessionConfig {
  if (!env.JWT_SECRET && env.NODE_ENV === 'development') {
    log?.warn('JWT_SECRET is not set: using the fixed development secret. Set JWT_SECRET for any shared deployment.');
  }
  return { key: new TextEncoder().encode(env.JWT_SECRET ?? DEV_SECRET), secure: env.NODE_ENV === 'production' };
}

export function cookieOptions(config: SessionConfig): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.secure, path: '/', maxAge: SESSION_TTL_SECONDS * 1000 };
}

export async function signSession(user: SessionUser, config: SessionConfig): Promise<string> {
  return new SignJWT({ role: user.role, name: user.name, email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(config.key);
}

const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** Returns the session user, or null for a missing, expired, tampered or malformed token. */
export async function verifySession(token: string | undefined, config: SessionConfig): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, config.key, { issuer: ISSUER, algorithms: ['HS256'] });
    const { sub, role, name, email } = payload;
    if (typeof sub !== 'string' || !isRole(role) || typeof name !== 'string' || typeof email !== 'string') return null;
    return { id: sub, role, name, email };
  } catch {
    return null;
  }
}

/** Reads one cookie from a raw Cookie header (used by the Socket.IO handshake). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
