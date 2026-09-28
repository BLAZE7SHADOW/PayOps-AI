/**
 * Background traffic: healthy payments spread over the last three days so tables look real.
 * Noise must never open a case; the scenario tests assert that.
 */
import { CARD_NETWORKS, PAYMENT_METHODS, type IdGenerator } from '@payops/shared';
import { checkout } from './checkout';
import type { ScenarioContext } from './context';
import type { MerchantKey } from './world';

const MERCHANT_KEYS: readonly MerchantKey[] = ['kavya', 'northwind', 'tandem'];
const MIN_AGE_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Rupee amounts typical for each merchant, in whole rupees. */
const AMOUNT_RANGE_RUPEES: Record<MerchantKey, [number, number]> = {
  kavya: [499, 45_000],
  northwind: [149, 4_500],
  tandem: [1_800, 38_000],
};

function amountFor(ids: IdGenerator, key: MerchantKey): number {
  const [min, max] = AMOUNT_RANGE_RUPEES[key];
  const rupees = ids.int(min, max);
  // Most prices end in 9 or 0; keep paise at 00 so amounts read like real prices.
  return (rupees - (rupees % 10) + ids.pick([0, 9, 9, 9])) * 100;
}

export async function writeNoise(ctx: ScenarioContext, count: number): Promise<void> {
  const { ids } = ctx;
  for (let i = 0; i < count; i++) {
    const key = ids.pick(MERCHANT_KEYS);
    const at = new Date(ctx.now.getTime() - ids.int(MIN_AGE_MS, MAX_AGE_MS));
    const method = ids.pick(PAYMENT_METHODS);
    await checkout(ctx, {
      amountMinor: amountFor(ids, key),
      at,
      customer: ids.pick(ctx.world.customers),
      merchant: ctx.world.merchants[key],
      method,
      card:
        method === 'CARD'
          ? { network: ids.pick(CARD_NETWORKS), country: 'IN', last4: String(ids.int(1000, 9999)) }
          : undefined,
      // One batch per merchant per capture day, like a real T+1 settlement file.
      batchGroup: `noise:${at.toISOString().slice(0, 10)}`,
    });
  }
}
