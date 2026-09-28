import { capturedButOrderFailed } from './captured-order-failed';
import type { ScenarioWriter } from './types';

/** As captured_order_failed, but the order service rejects replays with a version conflict. */
export const replayFailsThenReplan: ScenarioWriter = async (ctx) => {
  await capturedButOrderFailed(ctx, {
    amountMinor: 899_900,
    orderLocked: true,
    note: 'Money was debited from my card for ₹8,999 but my order shows failed.',
  });
};
