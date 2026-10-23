/**
 * `pnpm seed`: migrate, seed demo users and the base world, then generate every fault scenario once plus 30
 * healthy background payments. Fixed seeds make the demo data the same on every machine; a
 * second run skips scenarios that already exist.
 */
import { formatMoney } from '@payops/shared';
import { createCore, createDatabase, databasePoolSize, loadServerEnv, runMigrations } from '@payops/core';
import { seedDemoCases, seedWorld } from '@payops/simulator';
import { DEMO_PASSWORD, seedDemoUsers } from '../auth/demo-users';

const env = loadServerEnv();
const database = createDatabase(env.DATABASE_URL, { max: Math.min(2, databasePoolSize(env)), applicationName: 'payops-seed' });
try {
  await runMigrations(database.db);
  const core = createCore({ db: database.db });
  const users = await seedDemoUsers(database.db);
  console.warn(`demo users: ${users} created (password "${DEMO_PASSWORD}")`);
  await seedWorld(database.db, core.clock.now());

  await seedDemoCases(core, (key, paymentCount, caseIds) => {
    console.warn(
      paymentCount === 0
        ? `${key.padEnd(26)} already seeded, skipped`
        : `${key.padEnd(26)} ${String(paymentCount).padStart(3)} payments  cases: ${caseIds.join(', ') || 'none'}`,
    );
  });
  const overview = await core.overview.metrics();
  console.warn(
    `open exceptions: ${overview.openExceptions} · captured today: ${overview.capturedTodayCount} (${formatMoney(overview.capturedTodayMinor)})`,
  );
} finally {
  await database.close();
}
