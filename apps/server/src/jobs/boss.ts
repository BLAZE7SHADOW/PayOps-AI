import { PgBoss } from 'pg-boss';
import type { Logger } from '@payops/core';

/**
 * pg-boss keeps the job queue inside Postgres (schema "pgboss"), so there is no Redis.
 * Queues are created on start; handlers are registered by each feature.
 */
export const QUEUES = {
  reconcileSweep: 'reconcile-sweep',
} as const;

export async function startBoss(connectionString: string, log: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, max: 4, application_name: 'payops-jobs' });
  boss.on('error', (err: unknown) => log.error({ err }, 'job queue error'));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  log.info('job queue ready');
  return boss;
}
