/**
 * Small derived facts over an OrderSnapshot. Every rule and matrix cell is built from these, so
 * "what counts as captured" or "what the contract fee is" is decided in exactly one place.
 */
import { bpsOf, type GwPaymentStatus, type InternalPaymentStatus, type OrderStatus } from '@payops/shared';
import type { MerchantRow, OrderRow } from '../db/rows';
import type { GatewayPayment } from '../ports/gateway';
import type { OrderSnapshot } from './snapshot';

/** A gateway payment that was captured at some point, even if it was later refunded. */
const CAPTURED_ONCE: ReadonlySet<GwPaymentStatus> = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export const PAID_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(['PAID', 'FULFILLED']);

export function isCaptured(gw: Pick<GatewayPayment, 'status'> | null): boolean {
  return gw !== null && CAPTURED_ONCE.has(gw.status);
}

export function capturedGw(s: Pick<OrderSnapshot, 'gateway'>): GatewayPayment[] {
  return s.gateway.filter((g) => isCaptured(g));
}

/**
 * Captured gateway payments still holding customer money (not fully refunded). A duplicate
 * capture that has been refunded in full no longer counts as a duplicate.
 */
export function heldCaptures(s: Pick<OrderSnapshot, 'gateway'>): GatewayPayment[] {
  return capturedGw(s).filter((g) => g.amountMinor > g.refundedMinor);
}

/** Internal payment statuses that mean our records already know about the capture. */
export const CAPTURE_KNOWN_STATUSES: ReadonlySet<InternalPaymentStatus> = new Set([
  'CAPTURED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

export function capturedTotalMinor(s: Pick<OrderSnapshot, 'gateway'>): number {
  return sum(capturedGw(s).map((g) => g.amountMinor));
}

/** What the gateway says it has refunded across the order's captured payments. */
export function gatewayRefundedMinor(s: Pick<OrderSnapshot, 'gateway'>): number {
  return sum(capturedGw(s).map((g) => g.refundedMinor));
}

/** Captured money the customer has not been given back (by the gateway's account). */
export function outstandingCapturedMinor(s: Pick<OrderSnapshot, 'gateway'>): number {
  return Math.max(0, capturedTotalMinor(s) - gatewayRefundedMinor(s));
}

/** Net capture credit on MERCHANT_PAYABLE for the internal payment, excluding refund postings. */
export function captureCreditMinor(s: Pick<OrderSnapshot, 'ledger'>): number {
  let total = 0;
  for (const e of s.ledger) {
    if (e.account !== 'MERCHANT_PAYABLE' || e.refundId !== null) continue;
    total += e.direction === 'CREDIT' ? e.amountMinor : -e.amountMinor;
  }
  return total;
}

/** Refund money posted to the ledger (DEBIT MERCHANT_PAYABLE tagged with a refund). */
export function refundPostedMinor(s: Pick<OrderSnapshot, 'ledger'>): number {
  return sum(
    s.ledger
      .filter((e) => e.account === 'MERCHANT_PAYABLE' && e.refundId !== null && e.direction === 'DEBIT')
      .map((e) => e.amountMinor),
  );
}

/** Refund money the gateway reports as PROCESSED for the order. */
export function gatewayProcessedRefundMinor(s: Pick<OrderSnapshot, 'gwRefunds'>): number {
  return sum(s.gwRefunds.filter((r) => r.status === 'PROCESSED').map((r) => r.amountMinor));
}

export interface FeeBreakdown {
  feeMinor: number;
  taxMinor: number;
  netMinor: number;
}

/** What the merchant contract says a settlement line for `grossMinor` should look like. */
export function expectedFee(
  grossMinor: number,
  merchant: Pick<MerchantRow, 'feeBps' | 'feeFixedMinor' | 'taxBps'>,
): FeeBreakdown {
  const feeMinor = bpsOf(grossMinor, merchant.feeBps) + merchant.feeFixedMinor;
  const taxMinor = bpsOf(feeMinor, merchant.taxBps);
  return { feeMinor, taxMinor, netMinor: grossMinor - feeMinor - taxMinor };
}

/** When the order last moved into `to`, or null if it never did. */
export function lastTransitionAt(order: Pick<OrderRow, 'timeline'>, to: OrderStatus): Date | null {
  for (let i = order.timeline.length - 1; i >= 0; i--) {
    const t = order.timeline[i];
    if (t && t.to === to) return new Date(t.at);
  }
  return null;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function msSince(now: Date, then: Date | null): number {
  return then ? now.getTime() - then.getTime() : 0;
}
