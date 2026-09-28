import { checkout } from '../checkout';
import { DAY, HOUR, before, pickCustomer, type ScenarioWriter } from './types';

/** Merchant cancelled a ₹78,000 booking 3 days ago; no refund exists anywhere. */
export const refundNeverInitiated: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 7_800_000,
    at: before(ctx, 4 * DAY + 5 * HOUR),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.tandem,
    card: { network: 'AMEX', country: 'IN', last4: '1005' },
    cancelAt: before(ctx, 3 * DAY),
    cancelReason: 'Flight cancelled by airline',
  });
};
