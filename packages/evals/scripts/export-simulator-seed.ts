/**
 * Writes the fixture the Python simulator is tested against (D086): every table after `seedWorld` and `seedDemoCases` ran on an empty database with a fixed
 * clock, before any agent run. The Python tests generate the same data and compare rows (ids come from seeded generators, so they must be identical).
 * Output: python/payops/tests/fixtures/simulator_seed.json.gz
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCore } from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { seedDemoCases, seedWorld } from '../../simulator/src/index';

const NOW = '2026-09-28T12:00:00.000Z';

async function main() {
  process.env.NODE_ENV = 'test';
  const t = await startTestDatabase();
  try {
    const core = createCore({ db: t.db, clock: fixedClock(NOW), events: { publish: () => {} } });
    await seedWorld(t.db, core.clock.now());
    await seedDemoCases(core);
    const tables = (await t.pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map(
      (r: { table_name: string }) => r.table_name,
    );
    const db: Record<string, unknown[]> = {};
    for (const table of tables) db[table] = (await t.pool.query(`select to_jsonb(x) as row from "${table}" x`)).rows.map((r: { row: unknown }) => r.row);
    writeFileSync(resolve(import.meta.dirname, '../../../python/payops/tests/fixtures/simulator_seed.json.gz'), gzipSync(JSON.stringify({ now: NOW, tables: db })));
    console.log(Object.fromEntries(Object.entries(db).filter(([, v]) => v.length).map(([k, v]) => [k, v.length])));
  } finally {
    await t.close();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
