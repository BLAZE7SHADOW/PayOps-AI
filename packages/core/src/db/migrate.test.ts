import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';
import { cases } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('creates all tables', async () => {
    const { rows } = await t.pool.query<{ n: number }>(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(18);
  });

  it('enforces one open case per fingerprint', async () => {
    const base = {
      fingerprint: 'PAYMENT_MISMATCH:pay_1',
      type: 'PAYMENT_MISMATCH' as const,
      severity: 'HIGH' as const,
      priority: 1,
      amountMinor: 100,
      ruleIds: [],
      matrix: {} as never,
      entityRefs: {},
      lastDetectedAt: new Date(),
      openedAt: new Date(),
    };
    await t.db.insert(cases).values({ ...base, id: 'case_1', displayId: 'PAY-0001', status: 'OPEN' });
    await expect(
      t.db.insert(cases).values({ ...base, id: 'case_2', displayId: 'PAY-0002', status: 'OPEN' }),
    ).rejects.toThrow();
    await t.db.execute(sql`update cases set status = 'RESOLVED' where id = 'case_1'`);
    await t.db.insert(cases).values({ ...base, id: 'case_3', displayId: 'PAY-0003', status: 'OPEN' });
  });
});
