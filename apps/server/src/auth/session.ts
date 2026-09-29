/**
 * Sessions are a signed JWT (HS256, 8 hours) in an httpOnly cookie. The token carries a session id;
 * the sessions table decides whether that session is still live (see session-store.ts).
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

export async function signSession(user: SessionUser, sessionId: string, config: SessionConfig): Promise<string> {
  return new SignJWT({ role: user.role, name: user.name, email: user.email, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(config.key);
}

const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** What the cookie itself proves. The session store still has to confirm the session is live. */
export interface SessionClaims {
  user: SessionUser;
  sessionId: string;
}

/** Returns the claims, or null for a missing, expired, tampered or malformed token. */
export async function verifySession(token: string | undefined, config: SessionConfig): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, config.key, { issuer: ISSUER, algorithms: ['HS256'] });
    const { sub, role, name, email, sid } = payload;
    if (typeof sub !== 'string' || !isRole(role) || typeof name !== 'string' || typeof email !== 'string') return null;
    if (typeof sid !== 'string' || sid.length === 0) return null;
    return { user: { id: sub, role, name, email }, sessionId: sid };
  } catch {
    return null;
  }
}

/**
 * After the password is right but a one-time code is still owed, the browser gets this short
 * token instead of a session. It only proves "this user passed the password step" and cannot be
 * used as a session cookie (no `sid`, and a `purpose` claim sessions never carry).
 */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export async function signMfaChallenge(userId: string, config: SessionConfig): Promise<string> {
  return new SignJWT({ purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
    .sign(config.key);
}

/** The user id the challenge was issued for, or null if it is invalid, expired or not a challenge. */
export async function verifyMfaChallenge(token: string, config: SessionConfig): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, config.key, { issuer: ISSUER, algorithms: ['HS256'] });
    return payload.purpose === 'mfa' && typeof payload.sub === 'string' ? payload.sub : null;
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
