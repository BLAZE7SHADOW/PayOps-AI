/**
 * Zero-install local Postgres: PGlite (Postgres compiled to WASM) served over the Postgres wire
 * protocol on 127.0.0.1:54329, data persisted in .data/pglite. Use it instead of Docker or while
 * offline; point DATABASE_URL at Supabase for a real hosted database.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
const dataDir = resolve(process.cwd(), process.env.LOCAL_DB_DIR ?? '.data/pglite');
const ephemeral = process.argv.includes('--memory');

if (!ephemeral) mkdirSync(dataDir, { recursive: true });
const db = await PGlite.create(ephemeral ? undefined : dataDir);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 50 });
await server.start();
console.warn(
  `PGlite ready on postgres://postgres:postgres@127.0.0.1:${port}/postgres (${ephemeral ? 'in-memory' : dataDir})`,
);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
