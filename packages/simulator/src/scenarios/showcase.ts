import { checkout } from '../checkout';
import { capturedButOrderFailed } from './captured-order-failed';
import { HOUR, MIN, before, pickCustomer, type ScenarioWriter } from './types';

/** Four high-stakes extensions of existing payment faults. All values remain real domain rows. */
export const showcaseWebhookRecovery: ScenarioWriter = async (ctx) => {
  await capturedButOrderFailed(ctx, {
    amountMinor: 12_500_000,
    note: 'Our customer paid ₹1,25,000 yesterday, but the order still shows failed. Please reconcile the debit before retrying the charge.',
  });
};

export const showcaseDuplicateCapture: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 8_900_000,
    at: before(ctx, 26 * HOUR),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'RUPAY', country: 'IN', last4: '6521' },
    secondCapture: true,
    customerNote: { text: 'The same ₹89,000 order appears twice on my card. Please check which charge reached the merchant.', at: before(ctx, 23 * HOUR) },
  });
};

export const showcaseSettlementDispute: ScenarioWriter = async (ctx) => {
  const amounts = [459_900, 600_000_000, 89_900, 2_199_900, 649_900, 1_299_000];
  const start = before(ctx, 31 * HOUR);
  for (const [i, amountMinor] of amounts.entries()) {
    await checkout(ctx, {
      amountMinor,
      at: new Date(start.getTime() + i * 17 * MIN),
      customer: pickCustomer(ctx),
      merchant: ctx.world.merchants.kavya,
      method: i % 3 === 2 ? 'UPI' : 'CARD',
      batchGroup: 'enterprise',
      feeBpsOverride: i === 1 ? 300 : undefined,
    });
  }
};

export const showcaseLedgerGap: ScenarioWriter = async (ctx) => {
  await checkout(ctx, {
    amountMinor: 14_000_000,
    at: before(ctx, 31 * HOUR),
    customer: pickCustomer(ctx),
    merchant: ctx.world.merchants.kavya,
    card: { network: 'VISA', country: 'IN', last4: '4111' },
    skipLedger: true,
    customerNote: { text: 'The order says paid and the card was charged ₹1,40,000, but our merchant statement has no matching credit.', at: before(ctx, 27 * HOUR) },
  });
};
