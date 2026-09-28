import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDatabase, type Database } from '../db/client';
import { runMigrations } from '../db/migrate';

/**
 * Throwaway Postgres for tests: in-memory PGlite exposed over the Postgres wire protocol, so
 * code under test uses the exact same `pg` + Drizzle path as production.
 */
export interface TestDatabase extends Database {
  url: string;
  reset(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const pglite = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  const database = createDatabase(url, { max: 1, applicationName: 'payops-test' });
  await runMigrations(database.db);

  return {
    ...database,
    url,
    async reset() {
      const { rows } = await database.pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      if (rows.length) {
        await database.pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} cascade`);
      }
    },
    async close() {
      await database.pool.end();
      await server.stop();
      await pglite.close();
    },
  };
}
