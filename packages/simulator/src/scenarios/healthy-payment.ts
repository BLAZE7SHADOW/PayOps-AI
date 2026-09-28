import { checkout } from '../checkout';
import { DAY, MIN, before, pickCustomer, type ScenarioWriter } from './types';

/** Negative control: every system agrees. Captured a day ago so it is also settled. */
export const healthyPayment: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 2_349_900,
    at: before(ctx, DAY + ctx.ids.int(120, 240) * MIN),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'MASTERCARD', country: 'IN', last4: '5100' },
  });
};
