/**
 * Snapshot builders for reconciliation unit tests. `healthySnapshot()` is a fully consistent
 * order (captured, webhook delivered, order PAID, ledger posted, settled); tests then break one
 * thing at a time. Not exported from the package.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS, bpsOf } from '@payops/shared';
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
import type { OrderTransition } from '../db/schema';
import type {
  GatewayPayment,
  GatewayRefund,
  GatewaySettlementLine,
  GatewayWebhookDelivery,
} from '../ports/gateway';
import { pickPrimaryGw, type OrderSnapshot } from './snapshot';

export const NOW = new Date('2026-09-28T12:00:00.000Z');
export const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
export { DAY_MS, HOUR_MS, MINUTE_MS };

export function merchantRow(o: Partial<MerchantRow> = {}): MerchantRow {
  return {
    id: 'mer_1',
    name: 'Kavya Electronics',
    feeBps: 200,
    feeFixedMinor: 0,
    taxBps: 1800,
    settlementCycleDays: 1,
    createdAt: ago(400 * DAY_MS),
    updatedAt: ago(400 * DAY_MS),
    ...o,
  };
}

export function customerRow(o: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'cus_1',
    name: 'Aarav Sharma',
    emailMasked: 'a****@gmail.com',
    phoneMasked: '+91 ******4321',
    riskFlags: [],
    createdAt: ago(300 * DAY_MS),
    updatedAt: ago(300 * DAY_MS),
    ...o,
  };
}

export function transition(at: Date, from: OrderTransition['from'], to: OrderTransition['to'], by: string, reason: string | null = null): OrderTransition {
  return { at: at.toISOString(), from, to, by, reason };
}

export function orderRow(o: Partial<OrderRow> = {}): OrderRow {
  const createdAt = o.createdAt ?? ago(26 * HOUR_MS + MINUTE_MS);
  return {
    id: 'ord_1',
    merchantId: 'mer_1',
    customerId: 'cus_1',
    amountMinor: 1_249_900,
    status: 'PAID',
    paymentId: 'pay_1',
    version: 1,
    lockedReason: null,
    timeline: [transition(createdAt, null, 'PENDING', 'checkout'), transition(ago(26 * HOUR_MS - 2_000), 'PENDING', 'PAID', 'webhook-consumer')],
    createdAt,
    updatedAt: createdAt,
    ...o,
  };
}

export function paymentRow(o: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'pay_1',
    gwPaymentId: 'gwp_1',
    orderId: 'ord_1',
    merchantId: 'mer_1',
    customerId: 'cus_1',
    amountMinor: 1_249_900,
    method: 'CARD',
    status: 'CAPTURED',
    hold: false,
    recon: null,
    mismatch: false,
    createdAt: ago(26 * HOUR_MS + MINUTE_MS),
    updatedAt: ago(26 * HOUR_MS),
    ...o,
  };
}

export function gwPayment(o: Partial<GatewayPayment> = {}): GatewayPayment {
  return {
    id: 'gwp_1',
    orderRef: 'ord_1',
    merchantId: 'mer_1',
    amountMinor: 1_249_900,
    status: 'CAPTURED',
    method: 'CARD',
    card: { last4: '4242', network: 'VISA', country: 'IN' },
    capturedAt: ago(26 * HOUR_MS),
    refundedMinor: 0,
    createdAt: ago(26 * HOUR_MS + 30_000),
    ...o,
  };
}

export function delivery(o: Partial<GatewayWebhookDelivery> & { fail?: boolean } = {}): GatewayWebhookDelivery {
  const { fail, ...rest } = o;
  const start = ago(26 * HOUR_MS - 1_000).getTime();
  const attempts = fail
    ? [0, 1, 2].map((i) => ({ at: new Date(start + i * 5 * MINUTE_MS).toISOString(), httpStatus: 500, latencyMs: 1204 + i, error: 'Internal Server Error' }))
    : [{ at: new Date(start).toISOString(), httpStatus: 200, latencyMs: 180, error: null }];
  return {
    id: 'evt_1',
    event: 'payment.captured',
    gwPaymentId: 'gwp_1',
    gwRefundId: null,
    attempts,
    finalStatus: fail ? 'FAILED' : 'DELIVERED',
    createdAt: new Date(start),
    ...rest,
  };
}

export function ledgerLeg(o: Partial<LedgerEntryRow> = {}): LedgerEntryRow {
  return {
    id: 'led_1',
    journalId: 'jrn_1',
    paymentId: 'pay_1',
    refundId: null,
    batchId: null,
    merchantId: 'mer_1',
    account: 'MERCHANT_PAYABLE',
    direction: 'CREDIT',
    amountMinor: 1_249_900,
    postedAt: ago(26 * HOUR_MS - 3_000),
    source: 'SYSTEM',
    memo: 'capture',
    reversalOf: null,
    ...o,
  };
}

/** Two-leg capture journal: DEBIT SETTLEMENT_CLEARING / CREDIT MERCHANT_PAYABLE. */
export function captureJournal(amountMinor: number, o: Partial<LedgerEntryRow> = {}): LedgerEntryRow[] {
  return [
    ledgerLeg({ id: 'led_c1', account: 'SETTLEMENT_CLEARING', direction: 'DEBIT', amountMinor, ...o }),
    ledgerLeg({ id: 'led_c2', account: 'MERCHANT_PAYABLE', direction: 'CREDIT', amountMinor, ...o }),
  ];
}

export function settlementLine(
  gw: Pick<GatewayPayment, 'id' | 'amountMinor'>,
  merchant: Pick<MerchantRow, 'feeBps' | 'taxBps' | 'feeFixedMinor'>,
  o: Partial<GatewaySettlementLine> & { feeBps?: number } = {},
): GatewaySettlementLine {
  const { feeBps, ...rest } = o;
  const feeMinor = bpsOf(gw.amountMinor, feeBps ?? merchant.feeBps) + merchant.feeFixedMinor;
  const taxMinor = bpsOf(feeMinor, merchant.taxBps);
  return {
    id: `sln_${gw.id}`,
    batchId: 'stb_1',
    merchantId: 'mer_1',
    gwPaymentId: gw.id,
    grossMinor: gw.amountMinor,
    feeMinor,
    taxMinor,
    netMinor: gw.amountMinor - feeMinor - taxMinor,
    lineNo: 1,
    settledOn: ago(2 * HOUR_MS),
    ...rest,
  };
}

export function settlementRow(o: Partial<SettlementRow> = {}): SettlementRow {
  return {
    id: 'stb_1',
    merchantId: 'mer_1',
    settledOn: ago(2 * HOUR_MS),
    paymentIds: ['pay_1'],
    expectedNetMinor: 0,
    reportedNetMinor: 0,
    status: 'PENDING',
    createdAt: ago(2 * HOUR_MS),
    updatedAt: ago(2 * HOUR_MS),
    ...o,
  };
}

export function refundRow(o: Partial<RefundRow> = {}): RefundRow {
  return {
    id: 'rfd_1',
    paymentId: 'pay_1',
    gwPaymentId: 'gwp_1',
    gwRefundId: null,
    amountMinor: 345_000,
    status: 'PENDING',
    reason: 'Customer returned item',
    requestedAt: ago(9 * DAY_MS),
    createdAt: ago(9 * DAY_MS),
    updatedAt: ago(9 * DAY_MS),
    ...o,
  };
}

export function gwRefund(o: Partial<GatewayRefund> = {}): GatewayRefund {
  return {
    id: 'gwr_1',
    gwPaymentId: 'gwp_1',
    amountMinor: 345_000,
    status: 'PROCESSED',
    processedAt: ago(8 * DAY_MS),
    createdAt: ago(9 * DAY_MS),
    ...o,
  };
}

let attemptSeq = 0;
export function attempt(o: Partial<PaymentAttemptRow> = {}): PaymentAttemptRow {
  attemptSeq += 1;
  return {
    id: `att_${attemptSeq}`,
    customerId: 'cus_1',
    deviceId: 'dev_1',
    orderId: null,
    amountMinor: 4_500_000,
    result: 'FAILED',
    failureCode: 'CARD_DECLINED',
    cardCountry: 'IN',
    at: ago(27 * HOUR_MS),
    ...o,
  };
}

/** A fully consistent, settled order paid by card. */
export function healthySnapshot(o: { amountMinor?: number } = {}): OrderSnapshot {
  const amountMinor = o.amountMinor ?? 1_249_900;
  const merchant = merchantRow();
  const gw = gwPayment({ amountMinor });
  const payment = paymentRow({ amountMinor });
  return {
    now: NOW,
    order: orderRow({ amountMinor }),
    payment,
    gateway: [gw],
    primaryGw: gw,
    webhooks: [delivery()],
    ledger: captureJournal(amountMinor),
    refunds: [],
    gwRefunds: [],
    settlementLines: [settlementLine(gw, merchant)],
    settlement: settlementRow(),
    merchant,
    customer: customerRow(),
    recentAttempts: [attempt({ result: 'SUCCESS', failureCode: null, at: ago(26 * HOUR_MS), orderId: 'ord_1' })],
  };
}

/** Returns a copy with fields replaced; recomputes primaryGw unless given. */
export function withSnapshot(base: OrderSnapshot, patch: Partial<OrderSnapshot>): OrderSnapshot {
  const next = { ...base, ...patch };
  if (!('primaryGw' in patch)) next.primaryGw = pickPrimaryGw(next.gateway, next.payment);
  return next;
}

/** The captured_order_failed shape: captured, webhook 500 ×3, order FAILED, no ledger. */
export function capturedOrderFailedSnapshot(): OrderSnapshot {
  const base = healthySnapshot();
  const created = base.order.createdAt;
  return withSnapshot(base, {
    order: orderRow({
      status: 'FAILED',
      timeline: [
        transition(created, null, 'PENDING', 'checkout'),
        transition(new Date(created.getTime() + 15 * MINUTE_MS), 'PENDING', 'FAILED', 'checkout-timeout', 'No payment confirmation within 15 min'),
      ],
    }),
    payment: paymentRow({ status: 'PENDING' }),
    webhooks: [delivery({ fail: true })],
    ledger: [],
  });
}
