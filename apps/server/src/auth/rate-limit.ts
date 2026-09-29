/**
 * Fixed-window rate limiter kept in the database, so limits survive a restart and hold across
 * several server processes. One atomic upsert per attempt: it starts a new window when the old
 * one has ended, otherwise adds one, and returns the new count.
 */
import { lt, sql } from 'drizzle-orm';
import { AppError, tables, type ClockPort, type Db } from '@payops/core';

export class RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
  ) {}

  /** Counts one attempt for `key`; throws RATE_LIMITED once more than `limit` happen in `windowMs`. */
  async hit(key: string, limit: number, windowMs: number, message: string): Promise<void> {
    const now = this.clock.now();
    const resetAt = new Date(now.getTime() + windowMs);
    const result = await this.db.execute<{ count: number }>(sql`
      INSERT INTO auth_rate_limits (key, count, reset_at) VALUES (${key}, 1, ${resetAt.toISOString()}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN auth_rate_limits.reset_at <= ${now.toISOString()}::timestamptz THEN 1 ELSE auth_rate_limits.count + 1 END,
        reset_at = CASE WHEN auth_rate_limits.reset_at <= ${now.toISOString()}::timestamptz THEN ${resetAt.toISOString()}::timestamptz ELSE auth_rate_limits.reset_at END
      RETURNING count
    `);
    const count = Number(result.rows[0]?.count ?? 1);
    if (count > limit) throw new AppError('RATE_LIMITED', message);
  }

  /** Forgets a key, e.g. after a successful sign-in. */
  async clear(key: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${key}`);
  }

  /** Removes windows that ended long ago. Called now and then; not needed for correctness. */
  async purgeExpired(): Promise<void> {
    await this.db.delete(tables.authRateLimits).where(lt(tables.authRateLimits.resetAt, this.clock.now()));
  }
}
