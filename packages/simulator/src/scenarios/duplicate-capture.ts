import { checkout } from '../checkout';
import { HOUR, before, pickCustomer, type ScenarioWriter } from './types';

/** The gateway captured one ₹4,999 order twice; we only know about the first capture. */
export const duplicateCapture: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 499_900,
    at: before(ctx, 26 * HOUR),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'RUPAY', country: 'IN', last4: '6521' },
    secondCapture: true,
  });
};
