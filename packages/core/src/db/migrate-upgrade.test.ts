/**
 * 0001 must apply on top of a database created by 0000 that already holds refunds: the new
 * refunds.gw_payment_id is backfilled from the linked payment before NOT NULL is enforced.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDatabase, type Database } from './client';
import { MIGRATIONS_DIR, runMigrations } from './migrate';

let pglite: PGlite;
let server: PGLiteSocketServer;
let database: Database;

beforeAll(async () => {
  pglite = await PGlite.create();
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await server.start();
  database = createDatabase(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
});
afterAll(async () => {
  await database.close();
  await server.stop();
  await pglite.close();
});

describe('migration 0001 on an existing 0000 database', () => {
  it('backfills refunds.gw_payment_id', async () => {
    // A migrations folder containing only 0000.
    const dir = mkdtempSync(join(tmpdir(), 'payops-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag === '0000_init');
    writeFileSync(journalPath, JSON.stringify(journal));
    await runMigrations(database.db, dir);

    const q = (sql: string) => database.pool.query(sql);
    await q(`insert into merchants (id, name, fee_bps) values ('mer_1', 'M', 200)`);
    await q(`insert into customers (id, name, email_masked, phone_masked) values ('cus_1', 'C', 'c***@x.com', '+91 ******1234')`);
    await q(`insert into orders (id, merchant_id, customer_id, amount_minor, status) values ('ord_1', 'mer_1', 'cus_1', 1000, 'CANCELLED')`);
    await q(`insert into payments (id, gw_payment_id, order_id, merchant_id, customer_id, amount_minor, method, status) values ('pay_1', 'gwp_1', 'ord_1', 'mer_1', 'cus_1', 1000, 'CARD', 'CAPTURED')`);
    await q(`insert into refunds (id, payment_id, amount_minor, status, reason, requested_at) values ('rfd_1', 'pay_1', 1000, 'PENDING', 'r', now())`);

    await runMigrations(database.db);
    const { rows } = await database.pool.query<{ gw_payment_id: string }>(`select gw_payment_id from refunds where id = 'rfd_1'`);
    expect(rows[0]?.gw_payment_id).toBe('gwp_1');
    const tables = await database.pool.query<{ n: number }>(`select count(*)::int as n from pg_tables where tablename in ('resolutions','approvals','executions','validation_results','disputes')`);
    expect(tables.rows[0]?.n).toBe(5);
  });
});
