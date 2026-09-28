import type { PgBoss } from 'pg-boss';
import type { Core, Logger, ServerEnv } from '@payops/core';
import { QUEUES } from './boss';

/**
 * Background reconciliation: every minute, re-check recent orders and batches so faults that
 * appear later (a rule's 10-minute grace period passing, a 48h refund window closing) become
 * cases without anyone generating data. pg-boss cron resolution is one minute.
 */
export async function registerReconcileSweep(
  boss: PgBoss,
  core: Core,
  env: Pick<ServerEnv, 'RECONCILE_SWEEP_MS'>,
  log: Logger,
): Promise<void> {
  if (env.RECONCILE_SWEEP_MS === 0) {
    await boss.unschedule(QUEUES.reconcileSweep).catch(() => undefined);
    log.info('reconcile sweep disabled');
    return;
  }
  await boss.work(QUEUES.reconcileSweep, async ([job]) => {
    const started = Date.now();
    const summary = await core.reconciliation.sweep();
    log.info(
      { jobId: job?.id, checked: summary.checked, opened: summary.opened, updated: summary.updated, ms: Date.now() - started },
      'reconcile sweep done',
    );
  });
  await boss.schedule(QUEUES.reconcileSweep, '* * * * *');
  log.info('reconcile sweep scheduled every minute');
}
