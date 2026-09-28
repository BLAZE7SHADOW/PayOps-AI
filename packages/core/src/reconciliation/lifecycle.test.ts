import { describe, expect, it } from 'vitest';
import { buildLifecycle } from './lifecycle';
import {
  DAY_MS,
  MINUTE_MS,
  ago,
  attempt,
  capturedOrderFailedSnapshot,
  delivery,
  gwRefund,
  healthySnapshot,
  refundRow,
  withSnapshot,
} from './test-factory';

describe('buildLifecycle', () => {
  it('merges systems in time order', () => {
    const events = buildLifecycle(healthySnapshot());
    const ats = events.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
    expect(events.map((e) => `${e.system}:${e.title}`)).toEqual([
      'ORDER:Order created',
      'GATEWAY:Gateway payment created',
      'GATEWAY:Captured ₹12,499.00 at gateway',
      'WEBHOOK:payment.captured delivered',
      'ORDER:Order PENDING to PAID',
      'LEDGER:Capture posted to ledger',
      'SETTLEMENT:Settled in batch stb_1',
    ]);
  });

  it('shows each failed webhook attempt with status and latency', () => {
    const events = buildLifecycle(capturedOrderFailedSnapshot()).filter((e) => e.system === 'WEBHOOK');
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ title: 'payment.captured delivery failed', detail: 'Attempt 1 of 3 · HTTP 500 · 1,204 ms', tone: 'bad' });
    const order = buildLifecycle(capturedOrderFailedSnapshot()).find((e) => e.title === 'Order PENDING to FAILED');
    expect(order).toMatchObject({ tone: 'bad', detail: 'by checkout-timeout · No payment confirmation within 15 min' });
  });

  it('includes refunds from both worlds', () => {
    const s = withSnapshot(healthySnapshot(), {
      refunds: [refundRow()],
      gwRefunds: [gwRefund()],
      webhooks: [...healthySnapshot().webhooks, delivery({ id: 'evt_2', event: 'refund.processed', fail: true })],
    });
    const titles = buildLifecycle(s).filter((e) => e.system === 'REFUND').map((e) => e.title);
    expect(titles).toEqual(['Refund requested', 'Refund initiated at gateway', 'Refund processed at gateway']);
  });

  it('summarises repeated failed attempts as one risk event', () => {
    const failed = Array.from({ length: 8 }, (_, i) =>
      attempt({ at: ago(26 * 60 * MINUTE_MS + (60 - i * 7) * MINUTE_MS), cardCountry: ['IN', 'US', 'NG'][i % 3] ?? 'IN' }),
    );
    const risk = buildLifecycle(withSnapshot(healthySnapshot(), { recentAttempts: failed })).filter((e) => e.system === 'RISK');
    expect(risk).toEqual([
      expect.objectContaining({ title: '8 failed payment attempts in 49 min', detail: 'Card countries: IN, NG, US · Codes: CARD_DECLINED', tone: 'warn' }),
    ]);
  });

  it('skips risk events below three failures', () => {
    const s = withSnapshot(healthySnapshot(), { recentAttempts: [attempt({}), attempt({})] });
    expect(buildLifecycle(s).some((e) => e.system === 'RISK')).toBe(false);
  });

  it('never uses em dashes in user-facing text', () => {
    const s = withSnapshot(capturedOrderFailedSnapshot(), { refunds: [refundRow({ requestedAt: ago(DAY_MS) })], gwRefunds: [gwRefund()] });
    for (const e of buildLifecycle(s)) expect(`${e.title} ${e.detail ?? ''}`).not.toMatch(/—/);
  });
});
