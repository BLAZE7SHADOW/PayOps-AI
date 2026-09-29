import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { WEBHOOK_MAX_ATTEMPTS } from '@payops/shared';
import { auditEvents } from '../db/schema';
import { AppError } from '../errors';
import type { GatewayWebhookDelivery, PaymentGatewayPort } from '../ports/gateway';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';
import { AuditService } from './audit.service';
import type { ConsumerResult } from './webhook-consumer';
import { WebhookEventService, type WebhookRetryScheduler } from './webhook-event.service';

let t: TestDatabase;
const clock = fixedClock('2026-09-29T10:00:00.000Z');
const ops = { id: 'usr_ops', name: 'Ananya Rao' };

const event = (id = 'evt_1'): GatewayWebhookDelivery => ({
  id,
  event: 'payment.captured',
  gwPaymentId: 'gwpay_1',
  gwRefundId: null,
  attempts: [],
  finalStatus: 'PENDING',
  createdAt: new Date('2026-09-29T09:59:00.000Z'),
});

/** The consumer answers from a queue so each test scripts what happens on every attempt. */
let answers: ConsumerResult[];
const answer = (httpStatus: number, message = `answered ${httpStatus}`): ConsumerResult => ({
  httpStatus,
  outcome: httpStatus === 200 ? 'PROCESSED' : httpStatus === 409 ? 'ORDER_VERSION_CONFLICT' : 'ERROR',
  message,
});

let scheduled: Array<{ id: string; delaySeconds: number }>;
const scheduler: WebhookRetryScheduler = {
  async schedule(id, delaySeconds) {
    scheduled.push({ id, delaySeconds });
  },
};

let service: WebhookEventService;
let gatewayHasEvent: boolean;

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock.set('2026-09-29T10:00:00.000Z');
  await t.reset();
  answers = [];
  scheduled = [];
  gatewayHasEvent = true;
  // A stand-in gateway: replaying an event re-delivers it through the service, like the simulator.
  const gateway = {
    async replayWebhook(id: string) {
      if (!gatewayHasEvent) throw new AppError('NOT_FOUND', `Webhook event ${id} not found at the gateway`);
      const { httpStatus } = await service.receive(event(id));
      return { httpStatus, attemptAt: clock.now().toISOString() };
    },
  } as unknown as PaymentGatewayPort;
  service = new WebhookEventService(
    t.db,
    clock,
    new AuditService(t.db, clock),
    async () => answers.shift() ?? answer(200),
    gateway,
    scheduler,
  );
});

describe('receive', () => {
  it('logs a processed event with its payload and no retry', async () => {
    answers = [answer(200, 'Processed evt_1')];
    expect(await service.receive(event())).toEqual({ httpStatus: 200 });
    const d = await service.get('evt_1');
    expect(d.status).toBe('PROCESSED');
    expect(d.attemptCount).toBe(1);
    expect(d.payload).toMatchObject({ id: 'evt_1', event: 'payment.captured', gwPaymentId: 'gwpay_1' });
    expect(d.attempts[0]).toMatchObject({ source: 'GATEWAY', httpStatus: 200, message: 'Processed evt_1' });
    expect(d.nextRetryAt).toBeNull();
    expect(scheduled).toEqual([]);
  });

  it('marks a 500 as FAILED and queues the first retry in one minute', async () => {
    answers = [answer(500, 'boom')];
    await service.receive(event());
    const d = await service.get('evt_1');
    expect(d.status).toBe('FAILED');
    expect(d.lastHttpStatus).toBe(500);
    expect(d.nextRetryAt).toBe('2026-09-29T10:01:00.000Z');
    expect(scheduled).toEqual([{ id: 'evt_1', delaySeconds: 60 }]);
  });

  it('treats a 409 conflict as a failure worth retrying', async () => {
    answers = [answer(409)];
    await service.receive(event());
    expect((await service.get('evt_1')).status).toBe('FAILED');
  });

  it('keeps one row per event id and appends attempts', async () => {
    answers = [answer(500), answer(200)];
    await service.receive(event());
    await service.receive(event());
    const d = await service.get('evt_1');
    expect(d.attempts.map((a) => a.httpStatus)).toEqual([500, 200]);
    expect(d.status).toBe('PROCESSED');
    expect(d.nextRetryAt).toBeNull();
  });

  it('survives the queue being unavailable', async () => {
    answers = [answer(500)];
    const broken = new WebhookEventService(t.db, clock, new AuditService(t.db, clock), async () => answers.shift() ?? answer(200), {} as PaymentGatewayPort, {
      schedule: () => Promise.reject(new Error('queue down')),
    });
    await expect(broken.receive(event())).resolves.toEqual({ httpStatus: 500 });
    expect((await broken.get('evt_1')).status).toBe('FAILED');
  });
});

describe('retry queue', () => {
  it('backs off on each failed retry and then goes DEAD', async () => {
    answers = Array.from({ length: WEBHOOK_MAX_ATTEMPTS }, () => answer(500));
    await service.receive(event());
    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      clock.advance(3 * 60 * 60 * 1000);
      expect(await service.retry('evt_1')).toBe('RETRIED');
    }
    expect(scheduled.map((s) => s.delaySeconds)).toEqual([60, 300, 1800, 7200]);
    const d = await service.get('evt_1');
    expect(d.status).toBe('DEAD');
    expect(d.attemptCount).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(d.nextRetryAt).toBeNull();
    expect(d.attempts.slice(1).every((a) => a.source === 'RETRY')).toBe(true);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'webhook.dead'));
    expect(audit).toHaveLength(1);
  });

  it('stops retrying once an attempt succeeds', async () => {
    answers = [answer(500), answer(200)];
    await service.receive(event());
    clock.advance(61_000);
    expect(await service.retry('evt_1')).toBe('RETRIED');
    const d = await service.get('evt_1');
    expect(d.status).toBe('PROCESSED');
    expect(scheduled).toHaveLength(1);
  });

  it('skips a job that runs before the event is due', async () => {
    answers = [answer(500)];
    await service.receive(event());
    expect(await service.retry('evt_1')).toBe('SKIPPED');
    expect((await service.get('evt_1')).attemptCount).toBe(1);
  });

  it('skips events that are processed, dead or unknown', async () => {
    await service.receive(event('evt_ok'));
    expect(await service.retry('evt_ok')).toBe('SKIPPED');
    expect(await service.retry('evt_missing')).toBe('SKIPPED');
  });
});

describe('manual replay', () => {
  it('re-delivers through the gateway and audits who did it', async () => {
    answers = [answer(500), answer(200)];
    await service.receive(event());
    const d = await service.replay('evt_1', ops);
    expect(d.status).toBe('PROCESSED');
    expect(d.attempts[1]?.source).toBe('MANUAL');
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'webhook.replayed'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: 'usr_ops', entityId: 'evt_1' });
  });

  it('replays from the stored payload when the gateway no longer has the event', async () => {
    answers = [answer(500), answer(200)];
    await service.receive(event());
    gatewayHasEvent = false;
    const d = await service.replay('evt_1', ops);
    expect(d.status).toBe('PROCESSED');
    expect(d.attempts[1]).toMatchObject({ source: 'MANUAL', httpStatus: 200 });
  });

  it('keeps a DEAD event DEAD when the replay fails again', async () => {
    answers = Array.from({ length: WEBHOOK_MAX_ATTEMPTS + 1 }, () => answer(500));
    await service.receive(event());
    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      clock.advance(3 * 60 * 60 * 1000);
      await service.retry('evt_1');
    }
    const before = scheduled.length;
    const d = await service.replay('evt_1', ops);
    expect(d.status).toBe('DEAD');
    expect(d.attemptCount).toBe(WEBHOOK_MAX_ATTEMPTS + 1);
    expect(scheduled).toHaveLength(before);
  });

  it('rejects an unknown event id', async () => {
    await expect(service.replay('evt_nope', ops)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('list', () => {
  it('filters by status, newest first, and counts each status', async () => {
    answers = [answer(200), answer(500), answer(200)];
    await service.receive(event('evt_a'));
    clock.advance(1000);
    await service.receive(event('evt_b'));
    clock.advance(1000);
    await service.receive(event('evt_c'));
    const all = await service.list({ limit: 25 });
    expect(all.items.map((i) => i.id)).toEqual(['evt_c', 'evt_b', 'evt_a']);
    const failed = await service.list({ limit: 25, status: 'FAILED' });
    expect(failed.items.map((i) => i.id)).toEqual(['evt_b']);
    expect(await service.counts()).toEqual({ processed: 2, failed: 1, dead: 0 });
  });

  it('pages with a cursor', async () => {
    for (const id of ['evt_a', 'evt_b', 'evt_c']) {
      await service.receive(event(id));
      clock.advance(1000);
    }
    const first = await service.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((i) => i.id)).toEqual(['evt_a']);
    expect(second.nextCursor).toBeNull();
  });
});
