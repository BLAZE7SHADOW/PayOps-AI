import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { formatMoney, newId } from '@payops/shared';
import type { DbOrTx } from '../../db/client';
import { gwPayments, gwRefunds, gwSettlementLines, gwWebhookDeliveries, type DeliveryAttempt } from '../../db/schema';
import { AppError } from '../../errors';
import { systemClock, type ClockPort } from '../../ports/clock';
import type {
  GatewayPayment,
  GatewayRefund,
  GatewaySettlementLine,
  GatewayWebhookDelivery,
  PaymentGatewayPort,
  WebhookDeliveryResult,
  WebhookSink,
} from '../../ports/gateway';

/**
 * Gateway adapter backed by the simulator's gw_* tables. This is the "external world": the rest
 * of core reads gateway state only through PaymentGatewayPort, never from these tables directly.
 */
export class SimulatorGatewayAdapter implements PaymentGatewayPort {
  readonly name = 'simulator';
  private sink: WebhookSink | null = null;

  constructor(
    private readonly db: DbOrTx,
    private readonly clock: ClockPort = systemClock,
  ) {}

  /** Where webhooks go. The composition root connects our WebhookConsumer here. */
  setWebhookSink(sink: WebhookSink): void {
    this.sink = sink;
  }

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
    return rows.map(toDelivery);
  }

  async listRefunds(gwPaymentIds: readonly string[]): Promise<GatewayRefund[]> {
    if (gwPaymentIds.length === 0) return [];
    const rows = await this.db.select().from(gwRefunds).where(inArray(gwRefunds.gwPaymentId, [...gwPaymentIds]));
    return rows.map(toRefund);
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

  // ── Writes ────────────────────────────────────────────────────────────────

  async replayWebhook(eventId: string): Promise<WebhookDeliveryResult> {
    const [row] = await this.db.select().from(gwWebhookDeliveries).where(eq(gwWebhookDeliveries.id, eventId)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', `Webhook event ${eventId} not found at the gateway`);
    return this.deliver(toDelivery(row));
  }

  async createRefund(input: { gwPaymentId: string; amountMinor: number }): Promise<GatewayRefund> {
    const now = this.clock.now();
    const { refund, eventId } = await this.db.transaction(async (tx) => {
      const [payment] = await tx.select().from(gwPayments).where(eq(gwPayments.id, input.gwPaymentId)).for('update');
      if (!payment) throw new AppError('NOT_FOUND', `Gateway payment ${input.gwPaymentId} not found`);
      if (payment.status !== 'CAPTURED' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new AppError('CONFLICT', `Gateway refused the refund: payment ${payment.id} is ${payment.status}`);
      }
      const refundable = payment.amountMinor - payment.refundedMinor;
      if (input.amountMinor <= 0 || input.amountMinor > refundable) {
        throw new AppError(
          'CONFLICT',
          `Gateway refused the refund: ${formatMoney(input.amountMinor)} exceeds the refundable ${formatMoney(refundable)}`,
        );
      }
      // The simulated gateway processes refunds instantly.
      const refundedMinor = payment.refundedMinor + input.amountMinor;
      const [created] = await tx
        .insert(gwRefunds)
        .values({
          id: newId('gwRefund'),
          gwPaymentId: payment.id,
          amountMinor: input.amountMinor,
          status: 'PROCESSED',
          processedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error('gw refund insert returned no row');
      await tx
        .update(gwPayments)
        .set({ refundedMinor, status: refundedMinor >= payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED', updatedAt: now })
        .where(eq(gwPayments.id, payment.id));
      const id = newId('webhookEvent');
      await tx.insert(gwWebhookDeliveries).values({
        id,
        event: 'refund.processed',
        gwPaymentId: payment.id,
        gwRefundId: created.id,
        attempts: [],
        finalStatus: 'PENDING',
        createdAt: now,
        updatedAt: now,
      });
      return { refund: toRefund(created), eventId: id };
    });
    // Delivered after the gateway's own commit, exactly like a real webhook.
    await this.replayWebhook(eventId);
    return refund;
  }

  /**
   * One delivery attempt: hand the event to the sink (our consumer runs its own transaction),
   * then record the attempt. The two steps are strictly sequential, never nested.
   */
  private async deliver(event: GatewayWebhookDelivery): Promise<WebhookDeliveryResult> {
    const at = this.clock.now();
    const started = Date.now();
    let httpStatus: number | null = null;
    let error: string | null = null;
    if (!this.sink) {
      error = 'No webhook endpoint configured';
    } else {
      try {
        httpStatus = (await this.sink(event)).httpStatus;
      } catch (err) {
        httpStatus = 500;
        error = err instanceof Error ? err.message : 'Consumer error';
      }
    }
    const ok = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    if (!ok && error === null) error = httpStatus === 409 ? 'Conflict' : 'Consumer rejected the event';
    const attempt: DeliveryAttempt = { at: at.toISOString(), httpStatus, latencyMs: Date.now() - started, error };
    await this.db
      .update(gwWebhookDeliveries)
      .set({
        attempts: sql`${gwWebhookDeliveries.attempts} || ${JSON.stringify([attempt])}::jsonb`,
        finalStatus: ok ? 'DELIVERED' : 'FAILED',
        updatedAt: at,
      })
      .where(eq(gwWebhookDeliveries.id, event.id));
    return { httpStatus, attemptAt: attempt.at };
  }
}

function toDelivery(r: typeof gwWebhookDeliveries.$inferSelect): GatewayWebhookDelivery {
  return {
    id: r.id,
    event: r.event,
    gwPaymentId: r.gwPaymentId,
    gwRefundId: r.gwRefundId,
    attempts: r.attempts,
    finalStatus: r.finalStatus,
    createdAt: r.createdAt,
  };
}

function toRefund(r: typeof gwRefunds.$inferSelect): GatewayRefund {
  return {
    id: r.id,
    gwPaymentId: r.gwPaymentId,
    amountMinor: r.amountMinor,
    status: r.status,
    processedAt: r.processedAt,
    createdAt: r.createdAt,
  };
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
