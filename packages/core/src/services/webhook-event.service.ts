/**
 * The raw inbound webhook log, replay and retry queue (P3 task 2, D072).
 *
 * Every event the gateway sends passes through `receive`, which hands it to our consumer and then
 * records the attempt (never inside the consumer's transaction, so PGlite's serialised
 * transactions stay simple). A failed event is retried on the schedule in
 * `shared/webhook-retry.ts`; after the last attempt it is DEAD and only a person can replay it.
 * Replays go back through the gateway so both sides record the attempt; if the gateway no longer
 * has the event, the stored payload is used instead.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import {
  isWebhookSuccess,
  webhookRetryDelaySeconds,
  type Page,
  type WebhookAttemptSource,
  type WebhookLogCounts,
  type WebhookLogDetail,
  type WebhookLogItem,
  type WebhookLogListQuery,
  type WebhookLogStatus,
} from '@payops/shared';
import type { Db } from '../db/client';
import { webhookEvents } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { GatewayWebhookDelivery, PaymentGatewayPort } from '../ports/gateway';
import { WEBHOOK_CONSUMER_ACTOR, type AuditService } from './audit.service';
import { decodeCursor, encodeCursor, isRecord } from './cursor';
import type { ConsumerResult } from './webhook-consumer';

/** Queues a delayed retry job. The server backs this with pg-boss; tests use a fake. */
export interface WebhookRetryScheduler {
  schedule(eventId: string, delaySeconds: number): Promise<void>;
}

type Row = typeof webhookEvents.$inferSelect;

const toItem = (r: Row): WebhookLogItem => ({
  id: r.id,
  event: r.event,
  gwPaymentId: r.gwPaymentId,
  gwRefundId: r.gwRefundId,
  status: r.status,
  attemptCount: r.attemptCount,
  lastHttpStatus: r.lastHttpStatus,
  lastMessage: r.lastMessage,
  nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
  firstReceivedAt: r.firstReceivedAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toDetail = (r: Row): WebhookLogDetail => ({ ...toItem(r), payload: r.payload, attempts: r.attempts });

interface ListCursor {
  at: string;
  id: string;
}
const isListCursor = (v: unknown): v is ListCursor => isRecord(v) && typeof v.at === 'string' && typeof v.id === 'string';

export class WebhookEventService {
  /** Who triggered the delivery that is running now. The gateway's sink has no way to say. */
  private readonly source = new AsyncLocalStorage<WebhookAttemptSource>();

  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
    private readonly handle: (event: GatewayWebhookDelivery) => Promise<ConsumerResult>,
    private readonly gateway: PaymentGatewayPort,
    private readonly scheduler?: WebhookRetryScheduler,
  ) {}

  /** The gateway's webhook sink: run the consumer, log the attempt, queue a retry if it failed. */
  async receive(event: GatewayWebhookDelivery): Promise<{ httpStatus: number }> {
    const result = await this.handle(event);
    const row = await this.record(event, result, this.source.getStore() ?? 'GATEWAY');
    if (row.nextRetryAt) {
      const delaySeconds = Math.round((row.nextRetryAt.getTime() - this.clock.now().getTime()) / 1000);
      // A queue outage must not turn a logged failure into a lost one: the row keeps nextRetryAt.
      await this.scheduler?.schedule(row.id, delaySeconds).catch(() => undefined);
    }
    return { httpStatus: result.httpStatus };
  }

  /** Runs from the retry job. Does nothing unless the event is FAILED and its retry time has come. */
  async retry(id: string): Promise<'RETRIED' | 'SKIPPED'> {
    const row = await this.find(id);
    if (!row || row.status !== 'FAILED' || !row.nextRetryAt || row.nextRetryAt > this.clock.now()) return 'SKIPPED';
    await this.redeliver(row, 'RETRY');
    return 'RETRIED';
  }

  /** A person replays an event from the log, whatever its status. */
  async replay(id: string, by: { id: string; name: string }): Promise<WebhookLogDetail> {
    const row = await this.find(id);
    if (!row) throw notFound('Webhook event', id);
    await this.redeliver(row, 'MANUAL');
    const after = await this.find(id);
    if (!after) throw notFound('Webhook event', id);
    await this.audit.record({
      actorType: 'USER',
      actorId: by.id,
      actorName: by.name,
      action: 'webhook.replayed',
      entityType: 'webhook_event',
      entityId: id,
      summary: `Replayed ${row.event} ${id} from the event log: ${after.lastMessage} (${row.status} to ${after.status})`,
    });
    return toDetail(after);
  }

  async get(id: string): Promise<WebhookLogDetail> {
    const row = await this.find(id);
    if (!row) throw notFound('Webhook event', id);
    return toDetail(row);
  }

  /** Newest activity first, keyset-paginated on (updatedAt, id). */
  async list(query: WebhookLogListQuery): Promise<Page<WebhookLogItem>> {
    const conds: SQL[] = [];
    if (query.status) conds.push(eq(webhookEvents.status, query.status));
    if (query.event) conds.push(eq(webhookEvents.event, query.event));
    if (query.gwPaymentId) conds.push(eq(webhookEvents.gwPaymentId, query.gwPaymentId));
    const cursor = decodeCursor(query.cursor, isListCursor);
    if (cursor) {
      const at = new Date(cursor.at);
      conds.push(or(lt(webhookEvents.updatedAt, at), and(eq(webhookEvents.updatedAt, at), lt(webhookEvents.id, cursor.id))) as SQL);
    }
    const rows = await this.db
      .select()
      .from(webhookEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(webhookEvents.updatedAt), desc(webhookEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.updatedAt.toISOString(), id: last.id }) : null,
    };
  }

  async counts(): Promise<WebhookLogCounts> {
    const rows = await this.db.select({ status: webhookEvents.status, n: count() }).from(webhookEvents).groupBy(webhookEvents.status);
    const n = (s: WebhookLogStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    return { processed: n('PROCESSED'), failed: n('FAILED'), dead: n('DEAD') };
  }

  private async find(id: string): Promise<Row | undefined> {
    const [row] = await this.db.select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
    return row;
  }

  private async redeliver(row: Row, source: WebhookAttemptSource): Promise<void> {
    await this.source.run(source, async () => {
      try {
        await this.gateway.replayWebhook(row.id);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'NOT_FOUND')) throw err;
        await this.receive({
          ...row.payload,
          createdAt: new Date(row.payload.createdAt),
          attempts: [],
          finalStatus: 'FAILED',
        });
      }
    });
  }

  private async record(event: GatewayWebhookDelivery, result: ConsumerResult, source: WebhookAttemptSource): Promise<Row> {
    const now = this.clock.now();
    const existing = await this.find(event.id);
    const attempts = [
      ...(existing?.attempts ?? []),
      { at: now.toISOString(), source, httpStatus: result.httpStatus, outcome: result.outcome, message: result.message },
    ];
    const ok = isWebhookSuccess(result.httpStatus);
    const delay = ok || existing?.status === 'DEAD' ? null : webhookRetryDelaySeconds(attempts.length);
    const status: WebhookLogStatus = ok ? 'PROCESSED' : delay === null ? 'DEAD' : 'FAILED';
    const values = {
      status,
      attempts,
      attemptCount: attempts.length,
      lastHttpStatus: result.httpStatus,
      lastMessage: result.message,
      nextRetryAt: delay === null ? null : new Date(now.getTime() + delay * 1000),
      updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(webhookEvents).set(values).where(eq(webhookEvents.id, event.id)).returning()
      : await this.db
          .insert(webhookEvents)
          .values({
            id: event.id,
            event: event.event,
            gwPaymentId: event.gwPaymentId,
            gwRefundId: event.gwRefundId,
            payload: {
              id: event.id,
              event: event.event,
              gwPaymentId: event.gwPaymentId,
              gwRefundId: event.gwRefundId,
              createdAt: event.createdAt.toISOString(),
            },
            firstReceivedAt: now,
            ...values,
          })
          .returning();
    if (!row) throw new Error('webhook event upsert returned no row');
    if (status === 'DEAD' && existing?.status !== 'DEAD') {
      await this.audit.record({
        ...WEBHOOK_CONSUMER_ACTOR,
        action: 'webhook.dead',
        entityType: 'webhook_event',
        entityId: event.id,
        summary: `${event.event} ${event.id} failed ${attempts.length} times and is out of automatic retries: ${result.message}`,
      });
    }
    return row;
  }
}
