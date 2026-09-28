import type {
  CustomerRow,
  LedgerEntryRow,
  MerchantRow,
  OrderRow,
  PaymentAttemptRow,
  PaymentRow,
  RefundRow,
  SettlementRow,
} from '../db/rows';
import type {
  GatewayPayment,
  GatewayRefund,
  GatewaySettlementLine,
  GatewayWebhookDelivery,
} from '../ports/gateway';

/**
 * Everything reconciliation needs to know about one order, loaded once and then read by pure
 * functions (matrix, rules, lifecycle). Nothing in here is fetched lazily, so the same snapshot
 * always produces the same verdicts, which is what makes the rules easy to unit test.
 */
export interface OrderSnapshot {
  /** The instant the checks are evaluated at (from ClockPort). */
  now: Date;
  order: OrderRow;
  /** Our internal payment for the order, if one was ever created. */
  payment: PaymentRow | null;
  /** Every gateway payment whose orderRef is this order (more than one means duplicates). */
  gateway: GatewayPayment[];
  /** The gateway payment the internal payment points at, else the first captured, else the first. */
  primaryGw: GatewayPayment | null;
  webhooks: GatewayWebhookDelivery[];
  /** Ledger entries of the internal payment (capture and refund postings). */
  ledger: LedgerEntryRow[];
  refunds: RefundRow[];
  gwRefunds: GatewayRefund[];
  settlementLines: GatewaySettlementLine[];
  /** Internal settlement record for the primary payment's batch. */
  settlement: SettlementRow | null;
  merchant: MerchantRow;
  customer: CustomerRow;
  /** The customer's attempts in the 24 hours before the primary capture (or before `now`). */
  recentAttempts: PaymentAttemptRow[];
}

/** Picks the gateway payment that represents "the" payment for an order. */
export function pickPrimaryGw(
  gateway: readonly GatewayPayment[],
  payment: Pick<PaymentRow, 'gwPaymentId'> | null,
): GatewayPayment | null {
  if (payment) {
    const linked = gateway.find((g) => g.id === payment.gwPaymentId);
    if (linked) return linked;
  }
  return gateway.find((g) => g.status === 'CAPTURED') ?? gateway[0] ?? null;
}
