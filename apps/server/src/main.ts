import { createServer } from 'node:http';
import {
  createDatabase,
  createLogger,
  describeEnv,
  loadServerEnv,
  runMigrations,
} from '@payops/core';
import { createApp } from './app';
import { startBoss } from './jobs/boss';
import { createRealtime } from './realtime/socket';

const env = loadServerEnv();
const log = createLogger(env, 'payops');
log.info(describeEnv(env), 'starting');

const database = createDatabase(env.DATABASE_URL);
await runMigrations(database.db);
log.info('migrations applied');

const boss = await startBoss(env.DATABASE_URL, log);

const app = createApp({ env, log, database });
const http = createServer(app);
const { io } = createRealtime(http, { origin: env.WEB_ORIGIN, log });

http.listen(env.PORT, () => log.info(`listening on http://localhost:${env.PORT}`));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  io.close();
  http.close();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
  await database.close().catch(() => undefined);
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
