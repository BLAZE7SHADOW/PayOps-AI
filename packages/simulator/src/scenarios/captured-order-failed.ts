import { MINUTE_MS } from '@payops/shared';
import { checkout, type CheckoutOptions } from '../checkout';
import type { ScenarioContext } from '../context';
import { HOUR, before, pickCustomer, type ScenarioWriter } from './types';

/**
 * Gateway captured, payment.captured webhook got HTTP 500 three times, order timed out to FAILED,
 * no ledger credit. Captured 26 h ago so the gateway has already settled it.
 */
export async function capturedButOrderFailed(
  ctx: ScenarioContext,
  o: { amountMinor: number; note: string; orderLocked?: boolean; extra?: Partial<CheckoutOptions> },
) {
  const at = before(ctx, 26 * HOUR);
  return checkout(ctx, {
    amountMinor: o.amountMinor,
    at,
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'VISA', country: 'IN', last4: '4111' },
    webhook: 'fails',
    orderLocked: o.orderLocked,
    customerNote: { text: o.note, at: new Date(at.getTime() + 2 * HOUR + 7 * MINUTE_MS) },
    ...o.extra,
  });
}

export const capturedOrderFailed: ScenarioWriter = async (ctx) => {
  await capturedButOrderFailed(ctx, {
    amountMinor: 1_249_900,
    note: 'I was charged ₹12,499 for my order but the app says the payment failed. Please check.',
  });
};
