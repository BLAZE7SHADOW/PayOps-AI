import { loadServerEnv } from '../config/env';
import { createDatabase } from './client';
import { runMigrations } from './migrate';

const env = loadServerEnv();
const database = createDatabase(env.DATABASE_URL, { max: 1, applicationName: 'payops-migrate' });
try {
  await runMigrations(database.db);
  console.warn('migrations applied');
} finally {
  await database.close();
}
