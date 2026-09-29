import type { WebhookAttemptSource, WebhookLogItem, WebhookLogStatus } from '@payops/shared';
import type { Tone } from '../../lib/status';
import { dueLabel } from '@payops/shared';

export const STATUS_TONE: Record<WebhookLogStatus, Tone> = { PROCESSED: 'ok', FAILED: 'warn', DEAD: 'bad' };
export const STATUS_LABEL: Record<WebhookLogStatus, string> = { PROCESSED: 'Processed', FAILED: 'Failed', DEAD: 'Out of retries' };
export const SOURCE_LABEL: Record<WebhookAttemptSource, string> = { GATEWAY: 'Gateway', RETRY: 'Automatic retry', MANUAL: 'Replayed by a person' };

/** What happens next to an event, in words: the retry time, or that only a person can act. */
export function nextStep(e: Pick<WebhookLogItem, 'status' | 'nextRetryAt'>, now: Date): string {
  if (e.status === 'PROCESSED') return 'Nothing to do';
  if (e.status === 'DEAD') return 'Replay it by hand';
  if (!e.nextRetryAt) return 'Gateway is still retrying';
  return new Date(e.nextRetryAt).getTime() <= now.getTime() ? 'Retry is due' : `Retry ${dueLabel(e.nextRetryAt, now)}`;
}
