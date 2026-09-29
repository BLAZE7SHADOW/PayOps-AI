/**
 * `pnpm seed`: migrate, seed demo users and the base world, then generate every fault scenario once plus 30
 * healthy background payments. Fixed seeds make the demo data the same on every machine; a
 * second run skips scenarios that already exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS, formatMoney } from '@payops/shared';
import { AppError, DEFAULT_CASSETTE_DIR, createCore, createDatabase, databasePoolSize, loadServerEnv, runMigrations } from '@payops/core';
import { generateScenario, seedWorld } from '@payops/simulator';
import { DEMO_PASSWORD, seedDemoUsers } from '../auth/demo-users';

const NOISE_PAYMENTS = 30;
const BASE_SEED = 1000;

// Seed each fault with its first recorded seed, so every pre-loaded case can be investigated in
// REPLAY mode (fixtures/cassettes/manifest.json lists what has recorded AI responses).
const manifestFile = join(DEFAULT_CASSETTE_DIR, 'manifest.json');
const recorded: Array<{ scenario: string; seed: number }> = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : [];
const recordedSeed = (key: string): number | undefined => recorded.find((r) => r.scenario === key)?.seed;

const env = loadServerEnv();
const database = createDatabase(env.DATABASE_URL, { max: Math.min(2, databasePoolSize(env)), applicationName: 'payops-seed' });
try {
  await runMigrations(database.db);
  const core = createCore({ db: database.db });
  const users = await seedDemoUsers(database.db);
  console.warn(`demo users: ${users} created (password "${DEMO_PASSWORD}")`);
  await seedWorld(database.db, core.clock.now());

  const faults = SCENARIOS.filter((s) => s.expectedCaseType !== null);
  for (const [i, info] of faults.entries()) {
    try {
      const result = await generateScenario(core, { scenario: info.key, seed: recordedSeed(info.key) ?? BASE_SEED + i, noise: 0 });
      const cases = result.casesOpened.map((c) => c.displayId).join(', ') || 'none';
      console.warn(
        `${info.key.padEnd(26)} ${String(result.created.paymentIds.length).padStart(3)} payments  cases: ${cases}`,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT') console.warn(`${info.key.padEnd(26)} already seeded, skipped`);
      else throw err;
    }
  }
  try {
    await generateScenario(core, { scenario: 'healthy_payment', seed: BASE_SEED, noise: NOISE_PAYMENTS });
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'CONFLICT')) throw err;
  }
  const overview = await core.overview.metrics();
  console.warn(
    `open exceptions: ${overview.openExceptions} · captured today: ${overview.capturedTodayCount} (${formatMoney(overview.capturedTodayMinor)})`,
  );
} finally {
  await database.close();
}
