import { createServer } from 'node:http';
import {
  createCore,
  createDatabase,
  databasePoolSize,
  createLogger,
  describeEnv,
  loadServerEnv,
  runMigrations,
  type EventPublisherPort,
} from '@payops/core';
import { createApp } from './app';
import { seedDemoUsers } from './auth/demo-users';
import { sessionConfig } from './auth/session';
import { startBoss } from './jobs/boss';
import { registerReconcileSweep } from './jobs/reconcile';
import { createRealtime } from './realtime/socket';

const env = loadServerEnv();
const log = createLogger(env, 'payops');
log.info(describeEnv(env), 'starting');

const database = createDatabase(env.DATABASE_URL, { max: databasePoolSize(env) });
await runMigrations(database.db);
log.info('migrations applied');
const seededUsers = await seedDemoUsers(database.db);
if (seededUsers > 0) log.info({ seededUsers }, 'demo users created');
const session = sessionConfig(env, log);

// Socket.IO needs the HTTP server and the app needs core, so the publisher forwards to the
// realtime instance once it exists.
const realtime: { publisher?: EventPublisherPort } = {};
const events: EventPublisherPort = {
  publish: (room, event, payload) => realtime.publisher?.publish(room, event, payload),
};
const core = createCore({ db: database.db, events });

const boss = await startBoss(database.pool, log);
await registerReconcileSweep(boss, core, env, log);

const app = createApp({ env, log, database, core, session });
const http = createServer(app);
const { io, publisher } = createRealtime(http, { origin: env.WEB_ORIGIN, log, session });
realtime.publisher = publisher;

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
