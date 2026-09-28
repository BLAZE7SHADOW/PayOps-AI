import { and, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { gwPayments, gwRefunds, gwSettlementLines, gwWebhookDeliveries } from '../../db/schema';
import type {
  GatewayPayment,
  GatewayRefund,
  GatewaySettlementLine,
  GatewayWebhookDelivery,
  PaymentGatewayPort,
} from '../../ports/gateway';

/**
 * Gateway adapter backed by the simulator's gw_* tables. This is the "external world": the rest
 * of core reads gateway state only through PaymentGatewayPort, never from these tables directly.
 */
export class SimulatorGatewayAdapter implements PaymentGatewayPort {
  readonly name = 'simulator';

  constructor(private readonly db: DbOrTx) {}

  async getPayments(ids: readonly string[]): Promise<GatewayPayment[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(gwPayments).where(inArray(gwPayments.id, [...ids]));
    return rows.map(toPayment);
  }

  async listPaymentsByOrder(orderRefs: readonly string[]): Promise<GatewayPayment[]> {
    if (orderRefs.length === 0) return [];
    const rows = await this.db.select().from(gwPayments).where(inArray(gwPayments.orderRef, [...orderRefs]));
    return rows.map(toPayment);
  }

  async listWebhookDeliveries(gwPaymentIds: readonly string[]): Promise<GatewayWebhookDelivery[]> {
    if (gwPaymentIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(gwWebhookDeliveries)
      .where(inArray(gwWebhookDeliveries.gwPaymentId, [...gwPaymentIds]));
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      gwPaymentId: r.gwPaymentId,
      gwRefundId: r.gwRefundId,
      attempts: r.attempts,
      finalStatus: r.finalStatus,
      createdAt: r.createdAt,
    }));
  }

  async listRefunds(gwPaymentIds: readonly string[]): Promise<GatewayRefund[]> {
    if (gwPaymentIds.length === 0) return [];
    const rows = await this.db.select().from(gwRefunds).where(inArray(gwRefunds.gwPaymentId, [...gwPaymentIds]));
    return rows.map((r) => ({
      id: r.id,
      gwPaymentId: r.gwPaymentId,
      amountMinor: r.amountMinor,
      status: r.status,
      processedAt: r.processedAt,
      createdAt: r.createdAt,
    }));
  }

  async listSettlementLines(filter: {
    batchIds?: readonly string[];
    gwPaymentIds?: readonly string[];
  }): Promise<GatewaySettlementLine[]> {
    const conds = [];
    if (filter.batchIds?.length) conds.push(inArray(gwSettlementLines.batchId, [...filter.batchIds]));
    if (filter.gwPaymentIds?.length) conds.push(inArray(gwSettlementLines.gwPaymentId, [...filter.gwPaymentIds]));
    if (conds.length === 0) return [];
    const rows = await this.db.select().from(gwSettlementLines).where(or(...conds));
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      merchantId: r.merchantId,
      gwPaymentId: r.gwPaymentId,
      grossMinor: r.grossMinor,
      feeMinor: r.feeMinor,
      taxMinor: r.taxMinor,
      netMinor: r.netMinor,
      lineNo: r.lineNo,
      settledOn: r.settledOn,
    }));
  }

  async summarizeCaptures(range: { from: Date; to: Date }): Promise<{ count: number; amountMinor: number }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        amountMinor: sql<number>`coalesce(sum(${gwPayments.amountMinor}), 0)::bigint`.mapWith(Number),
      })
      .from(gwPayments)
      .where(and(gte(gwPayments.capturedAt, range.from), lt(gwPayments.capturedAt, range.to)));
    return { count: row?.count ?? 0, amountMinor: row?.amountMinor ?? 0 };
  }
}

function toPayment(r: typeof gwPayments.$inferSelect): GatewayPayment {
  return {
    id: r.id,
    orderRef: r.orderRef,
    merchantId: r.merchantId,
    amountMinor: r.amountMinor,
    status: r.status,
    method: r.method,
    card: r.card ?? null,
    capturedAt: r.capturedAt,
    refundedMinor: r.refundedMinor,
    createdAt: r.createdAt,
  };
}
