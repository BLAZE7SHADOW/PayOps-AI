/**
 * Writes one coherent payment lifecycle across both worlds (gateway tables and our internal
 * tables), with optional injected faults. Every timestamp derives from `at`, so a scenario can
 * be backdated relative to the clock and the detection rules see realistic ages.
 */
import {
  MINUTE_MS,
  type CardNetwork,
  type GwRefundStatus,
  type OrderStatus,
  type PaymentMethod,
  type RefundStatus,
} from '@payops/shared';
import { tables, type DeliveryAttempt, type OrderTransition } from '@payops/core';
import type { ScenarioContext } from './context';
import { merchantCycleMs } from './context';
import type { WorldCustomer, WorldMerchant } from './world';

export interface CardDetails {
  network: CardNetwork;
  country: string;
  last4: string;
}

export interface RefundOptions {
  amountMinor?: number;
  requestedAt: Date;
  reason: string;
  /** Our refund record's status. PROCESSED also posts the refund journal to the ledger. */
  internalStatus: RefundStatus;
  /** What the gateway did with it; omit if the refund never reached the gateway. */
  gateway?: { status: GwRefundStatus; processedAt?: Date };
  /** Delivery of refund.processed to us. */
  webhook?: 'delivered' | 'fails';
  /** The gateway refunded but we never created our own refund record (no ledger posting either). */
  skipInternal?: boolean;
}

export interface CheckoutOptions {
  amountMinor: number;
  /** When the customer started checkout (order created). */
  at: Date;
  customer: WorldCustomer;
  merchant: WorldMerchant;
  method?: PaymentMethod;
  card?: CardDetails;
  /**
   * payment.captured delivery. 'fails' = 3 attempts, HTTP 500, and the order times out.
   * 'pending' = two HTTP 503 attempts and a retry still scheduled, so the order is still PENDING.
   */
  webhook?: 'delivered' | 'fails' | 'pending';
  /** Out-of-order events: a stale payment.failed is applied after the capture and flips the order to FAILED. */
  staleFailureAt?: Date;
  /** The customer cancelled before the capture landed; the consumer still posted the ledger credit. */
  cancelledBeforeCaptureAt?: Date;
  /** Order service rejects webhook-driven transitions (fault for replay_fails_then_replan). */
  orderLocked?: boolean;
  /** Webhook processed but the ledger posting was lost. */
  skipLedger?: boolean;
  /** Include in a settlement file when T+1 has passed. Default true. */
  settle?: boolean;
  /** Settlement group key; payments with the same group and merchant share a batch. */
  batchGroup?: string;
  /** Fee the gateway actually charges on this line, if different from the contract. */
  feeBpsOverride?: number;
  /** The gateway captures the order a second time a minute later. */
  secondCapture?: boolean;
  /** Merchant cancels the order at this time. */
  cancelAt?: Date;
  cancelReason?: string;
  refund?: RefundOptions;
  deviceId?: string;
  /** Free-text complaint from the customer (untrusted). */
  customerNote?: { text: string; at: Date };
}

export interface CheckoutResult {
  orderId: string;
  paymentId: string;
  gwPaymentId: string;
  extraGwPaymentIds: string[];
  capturedAt: Date;
}

const SECOND_MS = 1_000;

const CARD_DEFAULT: CardDetails = { network: 'VISA', country: 'IN', last4: '4242' };

const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

export async function checkout(ctx: ScenarioContext, o: CheckoutOptions): Promise<CheckoutResult> {
  const { tx, ids } = ctx;
  const method = o.method ?? 'CARD';
  const card = method === 'CARD' ? (o.card ?? CARD_DEFAULT) : null;
  const webhook = o.webhook ?? 'delivered';
  const orderId = ids.next('order');
  const paymentId = ids.next('payment');
  const gwPaymentId = ids.next('gwPayment');
  const gwCreatedAt = plus(o.at, 20 * SECOND_MS);
  const capturedAt = plus(o.at, 30 * SECOND_MS);
  const deviceId = o.deviceId ?? o.customer.deviceId;

  // ── Order and internal payment as the order service sees them ───────────────
  const timeline: OrderTransition[] = [{ at: o.at.toISOString(), from: null, to: 'PENDING', by: 'checkout', reason: null }];
  let status: OrderStatus = 'PENDING';
  const move = (at: Date, to: OrderStatus, by: string, reason: string | null = null) => {
    timeline.push({ at: at.toISOString(), from: status, to, by, reason });
    status = to;
  };
  const delivered = webhook === 'delivered';
  if (o.cancelledBeforeCaptureAt) move(o.cancelledBeforeCaptureAt, 'CANCELLED', 'customer', 'Customer cancelled while the payment was in flight');
  else if (delivered) move(plus(capturedAt, 2 * SECOND_MS), 'PAID', 'webhook-consumer');
  else if (webhook === 'pending') {
    // Order stays PENDING while the gateway keeps retrying the webhook.
  } else move(plus(o.at, 15 * MINUTE_MS), 'FAILED', 'checkout-timeout', 'No payment confirmation within 15 min');
  if (o.staleFailureAt) move(o.staleFailureAt, 'FAILED', 'webhook-consumer', 'payment.failed from an earlier attempt applied after the capture');
  if (o.cancelAt) move(o.cancelAt, 'CANCELLED', 'merchant', o.cancelReason ?? 'Cancelled by merchant');

  await tx.insert(tables.orders).values({
    id: orderId,
    merchantId: o.merchant.id,
    customerId: o.customer.id,
    amountMinor: o.amountMinor,
    status,
    paymentId,
    version: timeline.length - 1,
    lockedReason: o.orderLocked ? 'VERSION_CONFLICT' : null,
    timeline,
    createdAt: o.at,
    updatedAt: new Date(timeline[timeline.length - 1]?.at ?? o.at),
  });

  // ── Gateway: payment, captured ───────────────────────────────────────────────
  const refund = o.refund;
  const refundAmount = refund?.amountMinor ?? o.amountMinor;
  const gwRefundProcessed = refund?.gateway?.status === 'PROCESSED';
  await tx.insert(tables.gwPayments).values({
    id: gwPaymentId,
    orderRef: orderId,
    merchantId: o.merchant.id,
    amountMinor: o.amountMinor,
    status: gwRefundProcessed ? (refundAmount >= o.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED') : 'CAPTURED',
    method,
    card,
    capturedAt,
    refundedMinor: gwRefundProcessed ? refundAmount : 0,
    createdAt: gwCreatedAt,
    updatedAt: capturedAt,
  });

  await tx.insert(tables.payments).values({
    id: paymentId,
    gwPaymentId,
    orderId,
    merchantId: o.merchant.id,
    customerId: o.customer.id,
    amountMinor: o.amountMinor,
    method,
    status: delivered ? (refund?.internalStatus === 'PROCESSED' ? 'REFUNDED' : 'CAPTURED') : 'PENDING',
    createdAt: gwCreatedAt,
    updatedAt: capturedAt,
  });

  await tx.insert(tables.paymentAttempts).values({
    id: ids.next('attempt'),
    customerId: o.customer.id,
    deviceId,
    orderId,
    amountMinor: o.amountMinor,
    result: 'SUCCESS',
    failureCode: null,
    cardCountry: card?.country ?? null,
    at: plus(o.at, 25 * SECOND_MS),
  });

  await insertDelivery(ctx, {
    event: 'payment.captured',
    gwPaymentId,
    gwRefundId: null,
    firstAt: plus(capturedAt, SECOND_MS),
    outcome: webhook,
  });

  if (delivered && !o.skipLedger) {
    await postJournal(ctx, {
      paymentId,
      refundId: null,
      merchantId: o.merchant.id,
      amountMinor: o.amountMinor,
      postedAt: plus(capturedAt, 3 * SECOND_MS),
      debit: 'SETTLEMENT_CLEARING',
      credit: 'MERCHANT_PAYABLE',
      memo: `Capture ${gwPaymentId}`,
    });
  }

  // ── Optional second capture on the same order (gateway-side duplicate) ───────
  const extraGwPaymentIds: string[] = [];
  if (o.secondCapture) {
    const dupId = ids.next('gwPayment');
    const dupCapturedAt = plus(capturedAt, 2 * MINUTE_MS);
    extraGwPaymentIds.push(dupId);
    await tx.insert(tables.gwPayments).values({
      id: dupId,
      orderRef: orderId,
      merchantId: o.merchant.id,
      amountMinor: o.amountMinor,
      status: 'CAPTURED',
      method,
      card,
      capturedAt: dupCapturedAt,
      refundedMinor: 0,
      createdAt: plus(dupCapturedAt, -10 * SECOND_MS),
      updatedAt: dupCapturedAt,
    });
    await tx.insert(tables.paymentAttempts).values({
      id: ids.next('attempt'),
      customerId: o.customer.id,
      deviceId,
      orderId,
      amountMinor: o.amountMinor,
      result: 'SUCCESS',
      failureCode: null,
      cardCountry: card?.country ?? null,
      at: plus(dupCapturedAt, -5 * SECOND_MS),
    });
    // Delivered, but the consumer ignores it: the order is already PAID.
    await insertDelivery(ctx, {
      event: 'payment.captured',
      gwPaymentId: dupId,
      gwRefundId: null,
      firstAt: plus(dupCapturedAt, SECOND_MS),
      outcome: 'delivered',
    });
  }

  // ── Optional refund ──────────────────────────────────────────────────────────
  if (refund) await writeRefund(ctx, { refund, amountMinor: refundAmount, paymentId, gwPaymentId, merchantId: o.merchant.id });

  if (o.customerNote) {
    await tx.insert(tables.supportNotes).values({
      id: ids.next('note'),
      paymentId,
      orderId,
      authorType: 'CUSTOMER',
      text: o.customerNote.text,
      createdAt: o.customerNote.at,
    });
  }

  // ── Settlement file (T+1) ────────────────────────────────────────────────────
  if (o.settle !== false) {
    const captures = [
      { id: gwPaymentId, at: capturedAt, paymentId },
      ...extraGwPaymentIds.map((id) => ({ id, at: plus(capturedAt, 2 * MINUTE_MS), paymentId: null })),
    ];
    for (const c of captures) {
      if (c.at.getTime() + merchantCycleMs > ctx.now.getTime()) continue;
      ctx.queueSettlement({
        group: o.batchGroup ?? 'main',
        merchant: o.merchant,
        gwPaymentId: c.id,
        paymentId: c.paymentId,
        grossMinor: o.amountMinor,
        capturedAt: c.at,
        feeBps: o.feeBpsOverride ?? o.merchant.feeBps,
      });
    }
  }

  ctx.created.orderIds.push(orderId);
  ctx.created.paymentIds.push(paymentId);
  return { orderId, paymentId, gwPaymentId, extraGwPaymentIds, capturedAt };
}

async function writeRefund(
  ctx: ScenarioContext,
  r: { refund: RefundOptions; amountMinor: number; paymentId: string; gwPaymentId: string; merchantId: string },
): Promise<void> {
  const { tx, ids } = ctx;
  const refundId = ids.next('refund');
  const gw = r.refund.gateway;
  const gwRefundId = gw ? ids.next('gwRefund') : null;
  const gwCreatedAt = plus(r.refund.requestedAt, MINUTE_MS);
  if (gw && gwRefundId) {
    const processedAt = gw.status === 'PENDING' ? null : (gw.processedAt ?? plus(gwCreatedAt, 6 * 60 * MINUTE_MS));
    await tx.insert(tables.gwRefunds).values({
      id: gwRefundId,
      gwPaymentId: r.gwPaymentId,
      amountMinor: r.amountMinor,
      status: gw.status,
      processedAt,
      createdAt: gwCreatedAt,
      updatedAt: processedAt ?? gwCreatedAt,
    });
    if (processedAt && gw.status === 'PROCESSED') {
      await insertDelivery(ctx, {
        event: 'refund.processed',
        gwPaymentId: r.gwPaymentId,
        gwRefundId,
        firstAt: plus(processedAt, SECOND_MS),
        outcome: r.refund.webhook ?? 'delivered',
      });
    }
  }
  if (r.refund.skipInternal) return;
  const updatedAt = r.refund.internalStatus === 'PROCESSED' && gw?.processedAt ? plus(gw.processedAt, 2 * SECOND_MS) : r.refund.requestedAt;
  await tx.insert(tables.refunds).values({
    id: refundId,
    paymentId: r.paymentId,
    gwPaymentId: r.gwPaymentId,
    gwRefundId,
    amountMinor: r.amountMinor,
    status: r.refund.internalStatus,
    reason: r.refund.reason,
    requestedAt: r.refund.requestedAt,
    createdAt: r.refund.requestedAt,
    updatedAt,
  });
  if (r.refund.internalStatus === 'PROCESSED') {
    await postJournal(ctx, {
      paymentId: r.paymentId,
      refundId,
      merchantId: r.merchantId,
      amountMinor: r.amountMinor,
      postedAt: updatedAt,
      debit: 'MERCHANT_PAYABLE',
      credit: 'SETTLEMENT_CLEARING',
      memo: `Refund ${refundId}`,
    });
  }
}

/** Two legs of one balanced posting. */
async function postJournal(
  ctx: ScenarioContext,
  j: {
    paymentId: string;
    refundId: string | null;
    merchantId: string;
    amountMinor: number;
    postedAt: Date;
    debit: 'SETTLEMENT_CLEARING' | 'MERCHANT_PAYABLE';
    credit: 'SETTLEMENT_CLEARING' | 'MERCHANT_PAYABLE';
    memo: string;
  },
): Promise<void> {
  const journalId = ctx.ids.next('journal');
  const base = {
    journalId,
    paymentId: j.paymentId,
    refundId: j.refundId,
    merchantId: j.merchantId,
    amountMinor: j.amountMinor,
    postedAt: j.postedAt,
    source: 'SYSTEM' as const,
    memo: j.memo,
  };
  await ctx.tx.insert(tables.ledgerEntries).values([
    { ...base, id: ctx.ids.next('ledgerEntry'), account: j.debit, direction: 'DEBIT' },
    { ...base, id: ctx.ids.next('ledgerEntry'), account: j.credit, direction: 'CREDIT' },
  ]);
}

/** Retry schedule for failed deliveries: immediately, +5 min, +30 min. */
const RETRY_OFFSETS_MS = [0, 5 * MINUTE_MS, 30 * MINUTE_MS];

async function insertDelivery(
  ctx: ScenarioContext,
  d: {
    event: 'payment.captured' | 'refund.processed';
    gwPaymentId: string;
    gwRefundId: string | null;
    firstAt: Date;
    outcome: 'delivered' | 'fails' | 'pending';
  },
): Promise<void> {
  const attempts: DeliveryAttempt[] =
    d.outcome === 'delivered'
      ? [{ at: d.firstAt.toISOString(), httpStatus: 200, latencyMs: ctx.ids.int(90, 420), error: null }]
      : (d.outcome === 'pending' ? RETRY_OFFSETS_MS.slice(0, 2) : RETRY_OFFSETS_MS).map((offset) => ({
          at: plus(d.firstAt, offset).toISOString(),
          httpStatus: d.outcome === 'pending' ? 503 : 500,
          latencyMs: ctx.ids.int(850, 1_600),
          error: d.outcome === 'pending' ? 'Service Unavailable' : 'Internal Server Error',
        }));
  const lastAt = new Date(attempts[attempts.length - 1]?.at ?? d.firstAt);
  const id = ctx.ids.next('webhookEvent');
  const finalStatus = d.outcome === 'delivered' ? 'DELIVERED' : d.outcome === 'pending' ? 'PENDING' : 'FAILED';
  await ctx.tx.insert(tables.gwWebhookDeliveries).values({
    id,
    event: d.event,
    gwPaymentId: d.gwPaymentId,
    gwRefundId: d.gwRefundId,
    attempts,
    finalStatus,
    createdAt: d.firstAt,
    updatedAt: lastAt,
  });
  // Our event log holds the same story as our consumer saw it. Retries here belong to the gateway
  // (it was still retrying, or gave up), so no retry of ours is queued: exhausted deliveries are
  // DEAD and wait for a person to replay them.
  await ctx.tx.insert(tables.webhookEvents).values({
    id,
    event: d.event,
    gwPaymentId: d.gwPaymentId,
    gwRefundId: d.gwRefundId,
    payload: { id, event: d.event, gwPaymentId: d.gwPaymentId, gwRefundId: d.gwRefundId, createdAt: d.firstAt.toISOString() },
    status: d.outcome === 'delivered' ? 'PROCESSED' : d.outcome === 'pending' ? 'FAILED' : 'DEAD',
    attempts: attempts.map((a) => ({
      at: a.at,
      source: 'GATEWAY' as const,
      httpStatus: a.httpStatus,
      outcome: a.httpStatus !== null && a.httpStatus < 300 ? 'PROCESSED' : 'ERROR',
      message: a.error ?? (d.event === 'payment.captured' ? 'Processed payment.captured' : 'Processed refund.processed'),
    })),
    attemptCount: attempts.length,
    lastHttpStatus: attempts[attempts.length - 1]?.httpStatus ?? null,
    lastMessage: attempts[attempts.length - 1]?.error ?? 'Processed',
    nextRetryAt: null,
    firstReceivedAt: d.firstAt,
    updatedAt: lastAt,
  });
}
