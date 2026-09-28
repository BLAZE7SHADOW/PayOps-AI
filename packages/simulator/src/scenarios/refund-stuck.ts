import { checkout } from '../checkout';
import { DAY, HOUR, before, pickCustomer, type ScenarioWriter } from './types';

/**
 * Refund requested 9 days ago, processed by the gateway 8 days ago, but the refund.processed
 * webhook failed, so our refund record is still PENDING and the ledger never saw it.
 */
export const refundStuck: ScenarioWriter = async (ctx) => {
  const requestedAt = before(ctx, 9 * DAY);
  await checkout(ctx, {
    amountMinor: 345_000,
    at: before(ctx, 12 * DAY + 3 * HOUR),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.northwind,
    method: 'UPI',
    cancelAt: requestedAt,
    cancelReason: 'Customer returned the order',
    refund: {
      requestedAt,
      reason: 'Customer returned the order',
      internalStatus: 'PENDING',
      gateway: { status: 'PROCESSED', processedAt: before(ctx, 8 * DAY) },
      webhook: 'fails',
    },
  });
};
