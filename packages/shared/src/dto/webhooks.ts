/** Inbound webhook log DTOs (P3 task 2, D072). */
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '../enums';

export const WEBHOOK_LOG_STATUS = ['PROCESSED', 'FAILED', 'DEAD'] as const;
export type WebhookLogStatus = (typeof WEBHOOK_LOG_STATUS)[number];

/** Who caused an attempt: the gateway's own delivery, an automatic retry, or a person's replay. */
export const WEBHOOK_ATTEMPT_SOURCES = ['GATEWAY', 'RETRY', 'MANUAL'] as const;
export type WebhookAttemptSource = (typeof WEBHOOK_ATTEMPT_SOURCES)[number];

export interface WebhookLogAttempt {
  at: string;
  source: WebhookAttemptSource;
  httpStatus: number | null;
  outcome: string;
  message: string;
}

export interface WebhookLogItem {
  id: string;
  event: WebhookEventType;
  gwPaymentId: string;
  gwRefundId: string | null;
  status: WebhookLogStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastMessage: string;
  nextRetryAt: string | null;
  firstReceivedAt: string;
  updatedAt: string;
}

export interface WebhookLogDetail extends WebhookLogItem {
  /** The event exactly as it reached our consumer. */
  payload: { id: string; event: WebhookEventType; gwPaymentId: string; gwRefundId: string | null; createdAt: string };
  attempts: WebhookLogAttempt[];
}

export const WebhookLogListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(WEBHOOK_LOG_STATUS).optional(),
  event: z.enum(WEBHOOK_EVENT_TYPES).optional(),
  gwPaymentId: z.string().trim().min(1).max(64).optional(),
});
export type WebhookLogListQuery = z.infer<typeof WebhookLogListQuery>;

export interface WebhookLogCounts {
  processed: number;
  failed: number;
  dead: number;
}
