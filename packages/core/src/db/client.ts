import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export { schema };
export type Db = NodePgDatabase<typeof schema>;
/** The handle passed to `db.transaction(async (tx) => ...)`. Services accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

// Postgres bigint (int8) comes back as string by default; our money columns use Drizzle's
// `mode: 'number'`, which converts. Raw COUNT(*) etc. are cast in SQL where needed.

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number; applicationName?: string } = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'payops',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
