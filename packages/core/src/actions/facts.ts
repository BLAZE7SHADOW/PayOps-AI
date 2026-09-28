/** Small derived facts the action handlers and the options builder share. */
import type { OrderSnapshot } from '../reconciliation/snapshot';

/**
 * What can still be refunded on one gateway payment: captured amount minus what the gateway has
 * refunded, minus refunds still pending at the gateway, minus our own refunds not yet sent.
 */
export function refundableMinor(s: OrderSnapshot, gwPaymentId: string): number {
  const gw = s.gateway.find((g) => g.id === gwPaymentId);
  if (!gw) return 0;
  const gatewayPending = s.gwRefunds
    .filter((r) => r.gwPaymentId === gwPaymentId && r.status === 'PENDING')
    .reduce((acc, r) => acc + r.amountMinor, 0);
  const internalUnsent = s.refunds
    .filter((r) => r.gwPaymentId === gwPaymentId && r.gwRefundId === null && (r.status === 'REQUESTED' || r.status === 'PENDING'))
    .reduce((acc, r) => acc + r.amountMinor, 0);
  return Math.max(0, gw.amountMinor - gw.refundedMinor - gatewayPending - internalUnsent);
}

export const NO_ORDER = 'This case has no order or payment to act on.';
