/**
 * `pnpm seed`: migrate, seed the base world, then generate every fault scenario once plus 30
 * healthy background payments. Fixed seeds make the demo data the same on every machine; a
 * second run skips scenarios that already exist.
 */
import { SCENARIOS, formatMoney } from '@payops/shared';
import { AppError, createCore, createDatabase, loadServerEnv, runMigrations } from '@payops/core';
import { generateScenario, seedWorld } from '@payops/simulator';

const NOISE_PAYMENTS = 30;
const BASE_SEED = 1000;

const env = loadServerEnv();
const database = createDatabase(env.DATABASE_URL, { max: 2, applicationName: 'payops-seed' });
try {
  await runMigrations(database.db);
  const core = createCore({ db: database.db });
  await seedWorld(database.db, core.clock.now());

  const faults = SCENARIOS.filter((s) => s.expectedCaseType !== null);
  for (const [i, info] of faults.entries()) {
    const noise = i === 0 ? NOISE_PAYMENTS : 0;
    try {
      const result = await generateScenario(core, { scenario: info.key, seed: BASE_SEED + i, noise });
      const cases = result.casesOpened.map((c) => c.displayId).join(', ') || 'none';
      console.warn(
        `${info.key.padEnd(26)} ${String(result.created.paymentIds.length).padStart(3)} payments  cases: ${cases}`,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT') console.warn(`${info.key.padEnd(26)} already seeded, skipped`);
      else throw err;
    }
  }
  const overview = await core.overview.metrics();
  console.warn(
    `open exceptions: ${overview.openExceptions} · captured today: ${overview.capturedTodayCount} (${formatMoney(overview.capturedTodayMinor)})`,
  );
} finally {
  await database.close();
}
