import { checkout } from '../checkout';
import { DAY, HOUR, MIN, before, pickCustomer, type ScenarioWriter } from './types';

/**
 * Messier variants of the core faults (P3 task 1): late and out-of-order events, partial refunds,
 * refunds that never left our side. Each opens exactly one case with the existing detection rules.
 */

/** Captured 45 min ago; the webhook is still being retried (two HTTP 503s), so the order is PENDING and the ledger is empty. */
export const lateWebhookRetrying: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 289_900,
    at: before(ctx, 45 * MIN),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.northwind,
    method: 'UPI',
    webhook: 'pending',
  });
};

/** A stale payment.failed from an earlier attempt is applied after the capture, so a paid order flips to FAILED. */
export const staleFailureAfterCapture: ScenarioWriter = async (ctx) => {
  const at = before(ctx, 27 * HOUR);
  await checkout(ctx, {
    amountMinor: 674_500,
    at,
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'MASTERCARD', country: 'IN', last4: '5454' },
    staleFailureAt: new Date(at.getTime() + 4 * MIN),
  });
};

/** ₹1,200 of a ₹4,800 order refunded at the gateway 9 days ago; our refund record is still PENDING. */
export const partialRefundStuck: ScenarioWriter = async (ctx) => {
  const requestedAt = before(ctx, 9 * DAY);
  await checkout(ctx, {
    amountMinor: 480_000,
    at: before(ctx, 12 * DAY),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.northwind,
    method: 'UPI',
    refund: {
      amountMinor: 120_000,
      requestedAt,
      reason: 'One item of three returned',
      internalStatus: 'PENDING',
      gateway: { status: 'PROCESSED', processedAt: before(ctx, 8 * DAY) },
      webhook: 'fails',
    },
  });
};

/** A refund was requested 8 days ago and our record is REQUESTED, but nothing ever reached the gateway. */
export const refundNeverReachedGateway: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 219_900,
    at: before(ctx, 11 * DAY),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'VISA', country: 'IN', last4: '4111' },
    refund: {
      requestedAt: before(ctx, 8 * DAY),
      reason: 'Product not as described',
      internalStatus: 'REQUESTED',
    },
  });
};

/** Cancelled order; the gateway refunded ₹6,000 of ₹15,000 but we have no refund record, so ₹9,000 is still owed. */
export const partialRefundShortfall: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 1_500_000,
    at: before(ctx, 5 * DAY),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.tandem,
    card: { network: 'VISA', country: 'IN', last4: '4242' },
    cancelAt: before(ctx, 3 * DAY),
    cancelReason: 'Trip shortened',
    refund: {
      amountMinor: 600_000,
      requestedAt: before(ctx, 3 * DAY),
      reason: 'Trip shortened',
      internalStatus: 'REQUESTED',
      gateway: { status: 'PROCESSED', processedAt: before(ctx, 2 * DAY + 20 * HOUR) },
      skipInternal: true,
    },
  });
};

/** The customer cancelled while the payment was in flight; the capture landed later, was credited, and no refund exists. */
export const cancelRacedCapture: ScenarioWriter = async (ctx) => {
  const at = before(ctx, 3 * DAY);
  await checkout(ctx, {
    amountMinor: 349_900,
    at,
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.tandem,
    card: { network: 'RUPAY', country: 'IN', last4: '6521' },
    cancelledBeforeCaptureAt: new Date(at.getTime() + 10_000),
  });
};
