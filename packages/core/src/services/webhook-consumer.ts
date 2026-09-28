/**
 * Our webhook consumer: what the gateway calls when something happens to a payment. It answers
 * like an HTTP handler (2xx = processed, 409 = conflict, 5xx = error) and does its work in its OWN
 * transaction, so the gateway adapter can record the delivery attempt only after it returns.
 *
 * Gateway reads happen before the transaction opens: PGlite serialises transactions across
 * connections, and the gateway port reads on its own connection.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { orders, payments } from '../db/schema';
import { AppError } from '../errors';
import type { GatewayWebhookDelivery, PaymentGatewayPort } from '../ports/gateway';
import { CAPTURE_KNOWN_STATUSES, captureCreditMinor, isCaptured } from '../reconciliation/facts';
import { WEBHOOK_CONSUMER_ACTOR, type AuditService, type WriteContext } from './audit.service';
import type { LedgerService } from './ledger.service';
import type { OrderService } from './order.service';
import type { PaymentService } from './payment.service';
import type { RefundService } from './refund.service';

export type ConsumerOutcome = 'PROCESSED' | 'NO_OP' | 'ORDER_VERSION_CONFLICT' | 'ERROR';

export interface ConsumerResult {
  httpStatus: number;
  outcome: ConsumerOutcome;
  message: string;
}

const ctx: WriteContext = { actor: WEBHOOK_CONSUMER_ACTOR };

const noop = (message: string): ConsumerResult => ({ httpStatus: 200, outcome: 'NO_OP', message });

export class WebhookConsumer {
  constructor(
    private readonly db: Db,
    private readonly gateway: PaymentGatewayPort,
    private readonly audit: AuditService,
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
    private readonly refunds: RefundService,
  ) {}

  async handle(event: GatewayWebhookDelivery): Promise<ConsumerResult> {
    try {
      switch (event.event) {
        case 'payment.captured':
          return await this.paymentCaptured(event);
        case 'refund.processed':
        case 'refund.failed':
          return await this.refundUpdated(event);
        default:
          return noop(`${event.event} needs no action`);
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'VERSION_CONFLICT' || err.code === 'INVALID_TRANSITION')) {
        return { httpStatus: 409, outcome: 'ORDER_VERSION_CONFLICT', message: err.message };
      }
      return { httpStatus: 500, outcome: 'ERROR', message: err instanceof Error ? err.message : 'Consumer error' };
    }
  }

  private async paymentCaptured(event: GatewayWebhookDelivery): Promise<ConsumerResult> {
    const [gw] = await this.gateway.getPayments([event.gwPaymentId]);
    if (!gw || !isCaptured(gw)) return noop(`Gateway payment ${event.gwPaymentId} is not captured`);

    return this.db.transaction(async (tx) => {
      const [payment] = await tx.select().from(payments).where(eq(payments.gwPaymentId, gw.id)).for('update').limit(1);
      if (!payment) return noop(`No internal payment for ${gw.id}; ignored`);
      const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
      if (!order) return noop(`Order ${payment.orderId} not found; ignored`);
      if (order.lockedReason) {
        // Injected fault (replay_fails_then_replan): the order service rejects webhook-driven
        // transitions. Nothing is written, so the replay changes nothing.
        return {
          httpStatus: 409,
          outcome: 'ORDER_VERSION_CONFLICT' as const,
          message: `Order ${order.id} rejected the update: ${order.lockedReason}`,
        };
      }

      const changes: string[] = [];
      if (!CAPTURE_KNOWN_STATUSES.has(payment.status)) {
        await this.payments.setStatus(tx, payment.id, 'CAPTURED', `payment.captured ${event.id}`, ctx);
        changes.push('payment CAPTURED');
      }
      if (order.status === 'PENDING' || order.status === 'FAILED') {
        await this.orders.transition(tx, order.id, 'PAID', { by: 'webhook-consumer', reason: `payment.captured ${event.id}`, paymentId: payment.id }, ctx);
        changes.push(`order ${order.status} to PAID`);
      }
      const isOrdersPayment = order.paymentId === null || order.paymentId === payment.id;
      if (isOrdersPayment) {
        const entries = await this.ledger.entriesForPayment(tx, payment.id);
        if (captureCreditMinor({ ledger: entries }) === 0) {
          await this.ledger.postCapture(tx, { paymentId: payment.id, merchantId: payment.merchantId, amountMinor: gw.amountMinor, source: 'SYSTEM' }, ctx);
          changes.push('capture posted');
        }
      }
      const message = changes.length ? `Processed ${event.id}: ${changes.join(', ')}` : `${event.id} already reflected`;
      await this.audit.record(
        { ...WEBHOOK_CONSUMER_ACTOR, action: 'webhook.processed', entityType: 'payment', entityId: payment.id, summary: message },
        tx,
      );
      return { httpStatus: 200, outcome: changes.length ? ('PROCESSED' as const) : ('NO_OP' as const), message };
    });
  }

  private async refundUpdated(event: GatewayWebhookDelivery): Promise<ConsumerResult> {
    if (!event.gwRefundId) return noop(`${event.id} carries no refund id`);
    const [gwRefunds, [gwPayment]] = await Promise.all([
      this.gateway.listRefunds([event.gwPaymentId]),
      this.gateway.getPayments([event.gwPaymentId]),
    ]);
    const gwRefund = gwRefunds.find((r) => r.id === event.gwRefundId);
    if (!gwRefund || !gwPayment) return noop(`Gateway refund ${event.gwRefundId} not found`);
    if (gwRefund.status === 'PENDING') return noop(`Gateway refund ${gwRefund.id} is still PENDING`);

    return this.db.transaction(async (tx) => {
      const refund = await this.refunds.findForGatewayRefund(tx, gwRefund);
      if (!refund) return noop(`No internal refund matches ${gwRefund.id}; ignored`);
      if (gwRefund.status === 'FAILED') {
        if (refund.status !== 'FAILED') await this.refunds.markFailed(tx, refund, `gateway refund ${gwRefund.id} failed`, ctx);
      } else {
        await this.refunds.applyGatewayStatus(tx, refund, gwRefund, gwPayment, 'SYSTEM', ctx);
      }
      const message = `Processed ${event.id}: refund ${refund.id} ${gwRefund.status}`;
      await this.audit.record(
        { ...WEBHOOK_CONSUMER_ACTOR, action: 'webhook.processed', entityType: 'refund', entityId: refund.id, summary: message },
        tx,
      );
      return { httpStatus: 200, outcome: 'PROCESSED' as const, message };
    });
  }
}
