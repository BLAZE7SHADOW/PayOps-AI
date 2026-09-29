/**
 * Server-side record of every signed-in browser. The cookie holds a signed JWT with a session id
 * (`sid`); a request is only accepted while that row exists, is not revoked and has not expired.
 * That is what makes "sign out everywhere" and "revoke this device" work, which a JWT alone cannot.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Role, SessionInfo, SessionUser } from '@payops/shared';
import { tables, type ClockPort, type Db } from '@payops/core';
import { SESSION_TTL_SECONDS } from './session';

/** lastSeenAt is refreshed at most this often, so a busy page does not write on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ActiveSession {
  id: string;
  user: SessionUser;
  mfaVerified: boolean;
}

export class SessionStore {
  private readonly revokedListeners: Array<(sessionIds: string[]) => void> = [];

  /** Called with the ids of sessions just revoked, e.g. to close their live sockets. */
  onRevoked(listener: (sessionIds: string[]) => void): void {
    this.revokedListeners.push(listener);
  }

  private notifyRevoked(ids: string[]): void {
    if (ids.length > 0) for (const listener of this.revokedListeners) listener(ids);
  }

  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
  ) {}

  async create(input: { userId: string; ip: string; userAgent: string; mfaVerified: boolean }): Promise<{ id: string; expiresAt: Date }> {
    const now = this.clock.now();
    const id = `ses_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    await this.db.insert(tables.sessions).values({
      id,
      userId: input.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ip: input.ip.slice(0, 64),
      userAgent: input.userAgent.slice(0, 300),
      mfaVerified: input.mfaVerified,
    });
    return { id, expiresAt };
  }

  /**
   * The session and its user as they are now (role and name come from the users table, so a role
   * change applies at once), or null if it is unknown, revoked, expired or belongs to someone else.
   */
  async resolve(sessionId: string, userId: string): Promise<ActiveSession | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .select({ session: tables.sessions, user: tables.users })
      .from(tables.sessions)
      .innerJoin(tables.users, eq(tables.users.id, tables.sessions.userId))
      .where(and(eq(tables.sessions.id, sessionId), eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt), gt(tables.sessions.expiresAt, now)))
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(tables.sessions).set({ lastSeenAt: now }).where(eq(tables.sessions.id, sessionId));
    }
    const { id, email, name, role } = row.user;
    return { id: sessionId, user: { id, email, name, role: role as Role }, mfaVerified: row.session.mfaVerified };
  }

  async listActive(userId: string, currentId: string | undefined): Promise<SessionInfo[]> {
    const rows = await this.db
      .select()
      .from(tables.sessions)
      .where(and(eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt), gt(tables.sessions.expiresAt, this.clock.now())))
      .orderBy(tables.sessions.createdAt);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      ip: r.ip,
      userAgent: r.userAgent,
      mfaVerified: r.mfaVerified,
      current: r.id === currentId,
    }));
  }

  /** Owner of a session, or null if it does not exist. Used to check who may revoke it. */
  async ownerOf(sessionId: string): Promise<string | null> {
    const [row] = await this.db.select({ userId: tables.sessions.userId }).from(tables.sessions).where(eq(tables.sessions.id, sessionId)).limit(1);
    return row?.userId ?? null;
  }

  /** Returns true if a live session was revoked. */
  async revoke(sessionId: string): Promise<boolean> {
    const rows = await this.db
      .update(tables.sessions)
      .set({ revokedAt: this.clock.now() })
      .where(and(eq(tables.sessions.id, sessionId), isNull(tables.sessions.revokedAt)))
      .returning({ id: tables.sessions.id });
    this.notifyRevoked(rows.map((r) => r.id));
    return rows.length > 0;
  }

  /** Revokes every live session of a user except `keepId`. Returns how many were revoked. */
  async revokeAllFor(userId: string, keepId?: string): Promise<number> {
    const conditions = [eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt)];
    if (keepId) conditions.push(ne(tables.sessions.id, keepId));
    const rows = await this.db
      .update(tables.sessions)
      .set({ revokedAt: this.clock.now() })
      .where(and(...conditions))
      .returning({ id: tables.sessions.id });
    this.notifyRevoked(rows.map((r) => r.id));
    return rows.length;
  }
}
