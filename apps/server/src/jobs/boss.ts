
import { PgBoss } from 'pg-boss';
import type { Database, Logger } from '@payops/core';

/**
 * pg-boss keeps the job queue inside Postgres (schema "pgboss"), so there is no Redis.
 * Queues are created on start; handlers are registered by each feature.
 */
export const QUEUES = {
  reconcileSweep: 'reconcile-sweep',
  agentRun: 'agent-run',
  agentResume: 'agent-resume',
  webhookRetry: 'webhook-retry',
} as const;

/**
 * pg-boss runs on the app's own pool (one set of connections for everything; fewer connections on
 * Supabase's free tier, and a single connection on local PGlite).
 */
export async function startBoss(pool: Database['pool'], log: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) } });
  boss.on('error', (err: unknown) => log.error({ err }, 'job queue error'));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  log.info('job queue ready');
  return boss;
}
