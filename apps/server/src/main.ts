import { createServer } from 'node:http';
import {
  createCore,
  createDatabase,
  createDecisionPort,
  databasePoolSize,
  createLogger,
  describeEnv,
  loadServerEnv,
  runMigrations,
  type AgentResumer,
  type WebhookRetryScheduler,
  type EventPublisherPort,
} from '@payops/core';
import { createApp } from './app';
import { seedDemoUsers } from './auth/demo-users';
import { sessionConfig } from './auth/session';
import { registerAgentJobs, type AgentResumeJobPayload } from './jobs/agents';
import { startBoss, QUEUES } from './jobs/boss';
import { registerReconcileSweep } from './jobs/reconcile';
import { registerWebhookRetryJob } from './jobs/webhooks';
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
// pg-boss (below) needs `core`, and `core`'s agent resumer needs pg-boss: same forwarding-box
// pattern as `events` above, resolved once startBoss() returns.
const boxedResumer: { resume?: AgentResumer['resume'] } = {};
const agentResumer: AgentResumer = {
  resume: (runId, decision) => {
    if (!boxedResumer.resume) throw new Error('agent resumer not ready yet');
    return boxedResumer.resume(runId, decision);
  },
};
// J1 signal intake uses the same Jev adapter as the agent graph, keyed to the default cassette
// in REPLAY/RECORD (agent runs pass their own scenarioKey; this app-wide path always uses 'default').
const decisionPort = createDecisionPort(env);
// Same forwarding box for webhook retries: core needs a scheduler, the scheduler needs pg-boss.
const boxedRetry: { schedule?: WebhookRetryScheduler['schedule'] } = {};
const webhookRetryScheduler: WebhookRetryScheduler = {
  schedule: (eventId, delaySeconds) => {
    if (!boxedRetry.schedule) return Promise.reject(new Error('webhook retry queue not ready yet'));
    return boxedRetry.schedule(eventId, delaySeconds);
  },
};
const core = createCore({ db: database.db, events, agentResumer, decision: decisionPort, webhookRetryScheduler });

const boss = await startBoss(database.pool, log);
await registerReconcileSweep(boss, core, env, log);
await registerAgentJobs(boss, core, env, log);
boxedRetry.schedule = (await registerWebhookRetryJob(boss, core, log)).schedule;
boxedResumer.resume = async (runId, decision) => {
  const payload: AgentResumeJobPayload = { runId, decision: { approvalId: null, decision } };
  await boss.send(QUEUES.agentResume, payload);
};

const app = createApp({ env, log, database, core, session, boss });
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
