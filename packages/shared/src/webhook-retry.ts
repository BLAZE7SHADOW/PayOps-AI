/**
 * Retry policy for inbound webhooks that our consumer failed to process (P3 task 2, D072).
 * Pure functions so the schedule is easy to test and to explain: a failed event is retried after
 * 1 minute, 5 minutes, 30 minutes, then 2 hours. After WEBHOOK_MAX_ATTEMPTS total attempts (the
 * first delivery counts) it is marked DEAD and only a person can replay it.
 */
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200] as const;

/** Seconds to wait before the next automatic attempt, or null when the event is out of attempts. */
export function webhookRetryDelaySeconds(attemptsSoFar: number): number | null {
  if (attemptsSoFar < 1 || attemptsSoFar >= WEBHOOK_MAX_ATTEMPTS) return null;
  return WEBHOOK_RETRY_DELAYS_SECONDS[attemptsSoFar - 1] ?? null;
}

/** A consumer answer counts as processed only for 2xx. 409 and 5xx are failures worth retrying. */
export const isWebhookSuccess = (httpStatus: number | null): boolean => httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
