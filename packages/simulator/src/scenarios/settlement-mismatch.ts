import { checkout } from '../checkout';
import { HOUR, MIN, before, pickCustomer, type ScenarioWriter } from './types';

/** Six payments in one batch; the ₹11,800 line is the one charged above contract. */
const BATCH_AMOUNTS_MINOR = [459_900, 1_180_000, 89_900, 2_199_900, 649_900, 1_299_000] as const;
const OVERCHARGED_INDEX = 1;

/**
 * One settlement batch of six Kavya Electronics payments. The gateway charged 300 bps on the
 * ₹11,800 line instead of the 200 bps contract, so the batch net is short.
 */
export const settlementMismatch: ScenarioWriter = async (ctx) => {
  const start = before(ctx, 31 * HOUR);
  for (const [i, amountMinor] of BATCH_AMOUNTS_MINOR.entries()) {
    await checkout(ctx, {
      amountMinor,
      at: new Date(start.getTime() + i * 17 * MIN),
      customer: pickCustomer(ctx),
      merchant: ctx.world.merchants.kavya,
      method: i % 3 === 2 ? 'UPI' : 'CARD',
      batchGroup: 'main',
      feeBpsOverride: i === OVERCHARGED_INDEX ? 300 : undefined,
    });
  }
};
