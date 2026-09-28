/**
 * Batched loading of OrderSnapshots. The number of queries is constant (about ten) no matter how
 * many orders are requested, so list endpoints and the sweep never do N+1 reads.
 */
import { and, gte, inArray, lt, or } from 'drizzle-orm';
import { DAY_MS } from '@payops/shared';
import type { DbOrTx } from '../db/client';
import type {
  CustomerRow,
  DeviceRow,
  DisputeRow,
  LedgerEntryRow,
  MerchantRow,
  PaymentAttemptRow,
  PaymentRow,
  RefundRow,
  SettlementRow,
} from '../db/rows';
import {
  customers,
  devices,
  disputes,
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

  // 4–12: everything keyed by those ids, in parallel.
  const [webhooks, gwRefundRows, lines, ledgerRows, refundRows, merchantRows, customerRows, attemptRows, deviceRows] =
    await Promise.all([
      gateway.listWebhookDeliveries(gwIds),
      gateway.listRefunds(gwIds),
      gateway.listSettlementLines({ gwPaymentIds: gwIds }),
      // Capture postings by internal payment, plus refund postings for any of the order's gateway
      // payments (a refunded duplicate capture has a refund journal but no internal payment).
      paymentIds.length || gwIds.length
        ? db
            .select()
            .from(ledgerEntries)
            .where(
              or(
                paymentIds.length ? inArray(ledgerEntries.paymentId, paymentIds) : undefined,
                gwIds.length
                  ? inArray(
                      ledgerEntries.refundId,
                      db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.gwPaymentId, gwIds)),
                    )
                  : undefined,
              ),
            )
        : Promise.resolve<LedgerEntryRow[]>([]),
      gwIds.length
        ? db.select().from(refunds).where(inArray(refunds.gwPaymentId, gwIds))
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
      // Risk (docs/03 §9 "getDeviceSignals"): every device seen for these customers, all-time —
      // there is no window here because a customer's device history (not just this window's
      // attempts) is exactly what identity-mismatch scoring needs.
      customerIds.length ? db.select().from(devices).where(inArray(devices.customerId, customerIds)) : Promise.resolve<DeviceRow[]>([]),
    ]);

  // 13: internal settlement rows for the batches we saw.
  const batchIds = uniq(lines.map((l) => l.batchId));
  const settlementRows = batchIds.length
    ? await db.select().from(settlements).where(inArray(settlements.id, batchIds))
    : [];

  // 14-15: merchant exposure (docs/03 §9 "getChargebackHistory"). Every settlement batch that
  // belongs to one of these merchants, then every dispute raised against any of those batches —
  // this is the closest signal this schema has to "how often has this merchant's money been
  // disputed", used as the merchant_exposure input to J3 (see docs/DECISIONS.md for why this is
  // a merchant-level proxy rather than a per-customer chargeback history, which the schema does
  // not model yet).
  const merchantSettlementRows = merchantIds.length
    ? await db.select({ id: settlements.id, merchantId: settlements.merchantId }).from(settlements).where(inArray(settlements.merchantId, merchantIds))
    : [];
  const merchantIdByBatch = new Map(merchantSettlementRows.map((s) => [s.id, s.merchantId]));
  const merchantBatchIds = uniq(merchantSettlementRows.map((s) => s.id));
  const merchantDisputeRows = merchantBatchIds.length
    ? await db.select().from(disputes).where(inArray(disputes.batchId, merchantBatchIds))
    : [];
  const disputesByMerchant = groupBy(merchantDisputeRows, (d) => merchantIdByBatch.get(d.batchId) ?? null);

  const paymentsByOrder = groupBy(paymentRows, (p) => p.orderId);
  const gwByOrder = groupBy(gwRows, (g) => g.orderRef);
  const webhooksByGw = groupBy(webhooks, (w) => w.gwPaymentId);
  const gwRefundsByGw = groupBy(gwRefundRows, (r) => r.gwPaymentId);
  const linesByGw = groupBy(lines, (l) => l.gwPaymentId);
  const ledgerByPayment = groupBy(ledgerRows, (e) => e.paymentId);
  const ledgerByRefund = groupBy(ledgerRows, (e) => e.refundId);
  const refundsByGw = groupBy(refundRows, (r) => r.gwPaymentId);
  const attemptsByCustomer = groupBy(attemptRows, (a) => a.customerId);
  const devicesByCustomer = groupBy(deviceRows, (d) => d.customerId);
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

    const orderRefunds = gateway.flatMap((g) => refundsByGw.get(g.id) ?? []);
    const ledgerById = new Map<string, LedgerEntryRow>();
    for (const e of payment ? (ledgerByPayment.get(payment.id) ?? []) : []) ledgerById.set(e.id, e);
    for (const r of orderRefunds) for (const e of ledgerByRefund.get(r.id) ?? []) ledgerById.set(e.id, e);

    snapshots.push({
      now,
      order,
      payment,
      gateway,
      primaryGw,
      webhooks: gateway.flatMap((g) => webhooksByGw.get(g.id) ?? []),
      ledger: [...ledgerById.values()].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.id.localeCompare(b.id)),
      refunds: orderRefunds.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()),
      gwRefunds: gateway.flatMap((g) => gwRefundsByGw.get(g.id) ?? []),
      settlementLines: orderLines,
      settlement: primaryLine ? (settlementById.get(primaryLine.batchId) ?? null) : null,
      merchant,
      customer,
      recentAttempts: (attemptsByCustomer.get(customer.id) ?? [])
        .filter((a: PaymentAttemptRow) => a.at.getTime() >= windowStart && a.at.getTime() < windowEnd)
        .sort((a, b) => a.at.getTime() - b.at.getTime()),
      devices: devicesByCustomer.get(customer.id) ?? [],
      merchantDisputes: disputesByMerchant.get(order.merchantId) ?? [],
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
  /** Disputes raised against this batch (any status). */
  disputes: DisputeRow[];
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
  const [merchantRows, paymentRows, disputeRows] = await Promise.all([
    db.select().from(merchants).where(inArray(merchants.id, uniq(settlementRows.map((s) => s.merchantId)))),
    gwIds.length
      ? db
          .select({ id: payments.id, orderId: payments.orderId, gwPaymentId: payments.gwPaymentId })
          .from(payments)
          .where(inArray(payments.gwPaymentId, gwIds))
      : Promise.resolve([]),
    db.select().from(disputes).where(inArray(disputes.batchId, ids)),
  ]);
  const disputesByBatch = groupBy(disputeRows, (d) => d.batchId);
  const merchantById = new Map(merchantRows.map((m) => [m.id, m]));
  const linesByBatch = groupBy(lines, (l) => l.batchId);
  const paymentsByGw = new Map(paymentRows.map((p) => [p.gwPaymentId, { id: p.id, orderId: p.orderId }]));
  const settlementById = new Map(settlementRows.map((s) => [s.id, s]));

  const out: BatchData[] = [];
  for (const id of ids) {
    const settlement = settlementById.get(id);
    const merchant = settlement ? merchantById.get(settlement.merchantId) : undefined;
    if (!settlement || !merchant) continue;
    out.push({
      settlement,
      merchant,
      lines: linesByBatch.get(id) ?? [],
      paymentsByGw,
      disputes: disputesByBatch.get(id) ?? [],
    });
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
