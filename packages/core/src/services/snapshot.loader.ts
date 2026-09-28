/**
 * Batched loading of OrderSnapshots. The number of queries is constant (about ten) no matter how
 * many orders are requested, so list endpoints and the sweep never do N+1 reads.
 */
import { and, gte, inArray, lt } from 'drizzle-orm';
import { DAY_MS } from '@payops/shared';
import type { DbOrTx } from '../db/client';
import type {
  CustomerRow,
  LedgerEntryRow,
  MerchantRow,
  PaymentAttemptRow,
  PaymentRow,
  RefundRow,
  SettlementRow,
} from '../db/rows';
import {
  customers,
  ledgerEntries,
  merchants,
  orders,
  paymentAttempts,
  payments,
  refunds,
  settlements,
} from '../db/schema';
import type { GatewaySettlementLine, PaymentGatewayPort } from '../ports/gateway';
import { pickPrimaryGw, type OrderSnapshot } from '../reconciliation/snapshot';
import { RULE_THRESHOLDS } from '../reconciliation/rules';

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const uniq = (values: Iterable<string>): string[] => [...new Set(values)];

/** Returns snapshots in the order of `orderIds`; unknown ids are skipped. */
export async function loadOrderSnapshots(
  db: DbOrTx,
  gateway: PaymentGatewayPort,
  orderIds: readonly string[],
  now: Date,
): Promise<OrderSnapshot[]> {
  const ids = uniq(orderIds);
  if (ids.length === 0) return [];

  // 1–3: orders, internal payments, gateway payments.
  const [orderRows, paymentRows, gwRows] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, ids)),
    db.select().from(payments).where(inArray(payments.orderId, ids)),
    gateway.listPaymentsByOrder(ids),
  ]);
  if (orderRows.length === 0) return [];

  const paymentIds = paymentRows.map((p) => p.id);
  const gwIds = gwRows.map((g) => g.id);
  const merchantIds = uniq(orderRows.map((o) => o.merchantId));
  const customerIds = uniq(orderRows.map((o) => o.customerId));
  const earliestWindowStart = new Date(
    Math.min(now.getTime(), ...gwRows.map((g) => g.capturedAt?.getTime() ?? now.getTime())) -
      RULE_THRESHOLDS.riskWindowMs,
  );

  // 4–11: everything keyed by those ids, in parallel.
  const [webhooks, gwRefundRows, lines, ledgerRows, refundRows, merchantRows, customerRows, attemptRows] =
    await Promise.all([
      gateway.listWebhookDeliveries(gwIds),
      gateway.listRefunds(gwIds),
      gateway.listSettlementLines({ gwPaymentIds: gwIds }),
      paymentIds.length
        ? db.select().from(ledgerEntries).where(inArray(ledgerEntries.paymentId, paymentIds))
        : Promise.resolve<LedgerEntryRow[]>([]),
      paymentIds.length
        ? db.select().from(refunds).where(inArray(refunds.paymentId, paymentIds))
        : Promise.resolve<RefundRow[]>([]),
      db.select().from(merchants).where(inArray(merchants.id, merchantIds)),
      db.select().from(customers).where(inArray(customers.id, customerIds)),
      db
        .select()
        .from(paymentAttempts)
        .where(
          and(
            inArray(paymentAttempts.customerId, customerIds),
            gte(paymentAttempts.at, earliestWindowStart),
            lt(paymentAttempts.at, new Date(now.getTime() + DAY_MS)),
          ),
        ),
    ]);

  // 12: internal settlement rows for the batches we saw.
  const batchIds = uniq(lines.map((l) => l.batchId));
  const settlementRows = batchIds.length
    ? await db.select().from(settlements).where(inArray(settlements.id, batchIds))
    : [];

  const paymentsByOrder = groupBy(paymentRows, (p) => p.orderId);
  const gwByOrder = groupBy(gwRows, (g) => g.orderRef);
  const webhooksByGw = groupBy(webhooks, (w) => w.gwPaymentId);
  const gwRefundsByGw = groupBy(gwRefundRows, (r) => r.gwPaymentId);
  const linesByGw = groupBy(lines, (l) => l.gwPaymentId);
  const ledgerByPayment = groupBy(ledgerRows, (e) => e.paymentId);
  const refundsByPayment = groupBy(refundRows, (r) => r.paymentId);
  const attemptsByCustomer = groupBy(attemptRows, (a) => a.customerId);
  const merchantById = new Map<string, MerchantRow>(merchantRows.map((m) => [m.id, m]));
  const customerById = new Map<string, CustomerRow>(customerRows.map((c) => [c.id, c]));
  const settlementById = new Map<string, SettlementRow>(settlementRows.map((s) => [s.id, s]));
  const orderById = new Map(orderRows.map((o) => [o.id, o]));

  const snapshots: OrderSnapshot[] = [];
  for (const id of ids) {
    const order = orderById.get(id);
    if (!order) continue;
    const merchant = merchantById.get(order.merchantId);
    const customer = customerById.get(order.customerId);
    if (!merchant || !customer) continue;

    const orderPayments = paymentsByOrder.get(id) ?? [];
    const payment: PaymentRow | null =
      orderPayments.find((p) => p.id === order.paymentId) ??
      [...orderPayments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null;
    const gateway = (gwByOrder.get(id) ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const primaryGw = pickPrimaryGw(gateway, payment);
    const orderLines: GatewaySettlementLine[] = gateway.flatMap((g) => linesByGw.get(g.id) ?? []);
    const primaryLine = orderLines.find((l) => l.gwPaymentId === primaryGw?.id);
    const windowEnd = (primaryGw?.capturedAt ?? now).getTime();
    const windowStart = windowEnd - RULE_THRESHOLDS.riskWindowMs;

    snapshots.push({
      now,
      order,
      payment,
      gateway,
      primaryGw,
      webhooks: gateway.flatMap((g) => webhooksByGw.get(g.id) ?? []),
      ledger: payment ? (ledgerByPayment.get(payment.id) ?? []) : [],
      refunds: payment ? (refundsByPayment.get(payment.id) ?? []) : [],
      gwRefunds: gateway.flatMap((g) => gwRefundsByGw.get(g.id) ?? []),
      settlementLines: orderLines,
      settlement: primaryLine ? (settlementById.get(primaryLine.batchId) ?? null) : null,
      merchant,
      customer,
      recentAttempts: (attemptsByCustomer.get(customer.id) ?? [])
        .filter((a: PaymentAttemptRow) => a.at.getTime() >= windowStart && a.at.getTime() < windowEnd)
        .sort((a, b) => a.at.getTime() - b.at.getTime()),
    });
  }
  return snapshots;
}

export interface BatchData {
  settlement: SettlementRow;
  lines: GatewaySettlementLine[];
  merchant: MerchantRow;
  /** gw payment id → internal payment (+ its order) for linking cases. */
  paymentsByGw: Map<string, Pick<PaymentRow, 'id' | 'orderId'>>;
}

/** Loads several settlement batches with a constant number of queries. */
export async function loadBatches(
  db: DbOrTx,
  gateway: PaymentGatewayPort,
  batchIds: readonly string[],
): Promise<BatchData[]> {
  const ids = uniq(batchIds);
  if (ids.length === 0) return [];
  const [settlementRows, lines] = await Promise.all([
    db.select().from(settlements).where(inArray(settlements.id, ids)),
    gateway.listSettlementLines({ batchIds: ids }),
  ]);
  if (settlementRows.length === 0) return [];
  const gwIds = uniq(lines.map((l) => l.gwPaymentId));
  const [merchantRows, paymentRows] = await Promise.all([
    db.select().from(merchants).where(inArray(merchants.id, uniq(settlementRows.map((s) => s.merchantId)))),
    gwIds.length
      ? db
          .select({ id: payments.id, orderId: payments.orderId, gwPaymentId: payments.gwPaymentId })
          .from(payments)
          .where(inArray(payments.gwPaymentId, gwIds))
      : Promise.resolve([]),
  ]);
  const merchantById = new Map(merchantRows.map((m) => [m.id, m]));
  const linesByBatch = groupBy(lines, (l) => l.batchId);
  const paymentsByGw = new Map(paymentRows.map((p) => [p.gwPaymentId, { id: p.id, orderId: p.orderId }]));
  const settlementById = new Map(settlementRows.map((s) => [s.id, s]));

  const out: BatchData[] = [];
  for (const id of ids) {
    const settlement = settlementById.get(id);
    const merchant = settlement ? merchantById.get(settlement.merchantId) : undefined;
    if (!settlement || !merchant) continue;
    out.push({ settlement, merchant, lines: linesByBatch.get(id) ?? [], paymentsByGw });
  }
  return out;
}

export async function loadBatch(
  db: DbOrTx,
  gateway: PaymentGatewayPort,
  batchId: string,
): Promise<BatchData | null> {
  const [batch] = await loadBatches(db, gateway, [batchId]);
  return batch ?? null;
}
