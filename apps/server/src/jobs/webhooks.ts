import type { PgBoss } from 'pg-boss';
import type { Core, Logger, WebhookRetryScheduler } from '@payops/core';
import { QUEUES } from './boss';

export interface WebhookRetryJobPayload {
  eventId: string;
}

/**
 * Retry queue for failed inbound webhooks (P3 task 2, D072). The delay comes from the event log,
 * which decides the backoff; the job only asks the log to retry. If the job runs early, or a
 * person already replayed the event, `retry` does nothing.
 */
export async function registerWebhookRetryJob(boss: PgBoss, core: Core, log: Logger): Promise<WebhookRetryScheduler> {
  await boss.work<WebhookRetryJobPayload>(QUEUES.webhookRetry, async ([job]) => {
    if (!job) return;
    const outcome = await core.webhookEvents.retry(job.data.eventId);
    log.info({ jobId: job.id, eventId: job.data.eventId, outcome }, 'webhook retry job done');
  });
  return {
    async schedule(eventId, delaySeconds) {
      const payload: WebhookRetryJobPayload = { eventId };
      await boss.send(QUEUES.webhookRetry, payload, { startAfter: delaySeconds });
    },
  };
}
