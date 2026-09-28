/**
 * Our refund records. A refund is created REQUESTED before we call the gateway, linked to the
 * gateway refund once it exists, and marked PROCESSED (with its ledger journal) when the gateway
 * confirms, either by webhook or by an analyst syncing the status.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { formatMoney, newId, type GwRefundStatus, type LedgerSource, type RefundStatus } from '@payops/shared';
import type { Tx } from '../db/client';
import type { RefundRow } from '../db/rows';
import { payments, refunds } from '../db/schema';
import { notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { GatewayPayment, GatewayRefund } from '../ports/gateway';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';
import type { LedgerService } from './ledger.service';
import type { PaymentService } from './payment.service';

/** Our refund status that corresponds to a gateway refund status. */
export const REFUND_STATUS_FROM_GATEWAY: Record<GwRefundStatus, RefundStatus> = {
  PENDING: 'PENDING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
};

export class RefundService {
  constructor(
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentService,
  ) {}

  async lock(tx: Tx, refundId: string): Promise<RefundRow> {
    const [row] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for('update');
    if (!row) throw notFound('Refund', refundId);
    return row;
  }

  /** Records our intent to refund before the gateway is called. */
  async createRequested(
    tx: Tx,
    input: { gwPaymentId: string; amountMinor: number; reason: string },
    ctx: WriteContext,
  ): Promise<RefundRow> {
    const [payment] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.gwPaymentId, input.gwPaymentId)).limit(1);
    const now = this.clock.now();
    const [row] = await tx
      .insert(refunds)
      .values({
        id: newId('refund'),
        paymentId: payment?.id ?? null,
        gwPaymentId: input.gwPaymentId,
        gwRefundId: null,
        amountMinor: input.amountMinor,
        status: 'REQUESTED',
        reason: input.reason,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('refund insert returned no row');
    await this.audit.record(
      auditFrom(ctx, {
        action: 'refund.requested',
        entityType: 'refund',
        entityId: row.id,
        summary: `Refund ${row.id} of ${formatMoney(row.amountMinor)} requested on ${input.gwPaymentId}: ${input.reason}`,
        after: { amountMinor: row.amountMinor, gwPaymentId: input.gwPaymentId, paymentId: row.paymentId },
      }),
      tx,
    );
    return row;
  }

  /**
   * The internal refund a gateway refund belongs to: the one already linked to it, else the oldest
   * unlinked REQUESTED/PENDING refund on the same payment for the same amount.
   */
  async findForGatewayRefund(tx: Tx, gw: Pick<GatewayRefund, 'id' | 'gwPaymentId' | 'amountMinor'>): Promise<RefundRow | null> {
    const [linked] = await tx.select().from(refunds).where(eq(refunds.gwRefundId, gw.id)).for('update').limit(1);
    if (linked) return linked;
    const [unlinked] = await tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.gwPaymentId, gw.gwPaymentId),
          eq(refunds.amountMinor, gw.amountMinor),
          isNull(refunds.gwRefundId),
          inArray(refunds.status, ['REQUESTED', 'PENDING']),
        ),
      )
      .orderBy(asc(refunds.requestedAt), asc(refunds.id))
      .for('update')
      .limit(1);
    return unlinked ?? null;
  }

  /**
   * Brings our refund in line with the gateway refund: links it, copies the status, and for
   * PROCESSED posts the refund journal (once) and mirrors the payment's refunded status.
   * Returns the refund after the change.
   */
  async applyGatewayStatus(
    tx: Tx,
    refund: RefundRow,
    gw: GatewayRefund,
    /** The gateway payment the refund is against, read by the caller before the transaction. */
    gwPayment: Pick<GatewayPayment, 'status' | 'merchantId'>,
    source: LedgerSource,
    ctx: WriteContext,
  ): Promise<RefundRow> {
    const status = REFUND_STATUS_FROM_GATEWAY[gw.status];
    const now = this.clock.now();
    let row = refund;
    if (refund.status !== status || refund.gwRefundId !== gw.id) {
      const [updated] = await tx
        .update(refunds)
        .set({ status, gwRefundId: gw.id, updatedAt: now })
        .where(eq(refunds.id, refund.id))
        .returning();
      if (!updated) throw notFound('Refund', refund.id);
      row = updated;
      await this.audit.record(
        auditFrom(ctx, {
          action: 'refund.status_changed',
          entityType: 'refund',
          entityId: refund.id,
          summary: `Refund ${refund.id} moved ${refund.status} to ${status} to match gateway refund ${gw.id}`,
          before: { status: refund.status, gwRefundId: refund.gwRefundId },
          after: { status, gwRefundId: gw.id },
        }),
        tx,
      );
    }
    if (status === 'PROCESSED') {
      if (!(await this.ledger.hasLiveRefundJournal(tx, row.id))) {
        await this.ledger.postRefund(
          tx,
          {
            refundId: row.id,
            paymentId: row.paymentId,
            gwPaymentId: row.gwPaymentId,
            merchantId: gwPayment.merchantId,
            amountMinor: row.amountMinor,
            source,
          },
          ctx,
        );
      }
      if (row.paymentId && (gwPayment.status === 'REFUNDED' || gwPayment.status === 'PARTIALLY_REFUNDED')) {
        await this.payments.setStatus(tx, row.paymentId, gwPayment.status, `gateway shows the payment ${gwPayment.status}`, ctx);
      }
    }
    return row;
  }

  async markFailed(tx: Tx, refund: RefundRow, reason: string, ctx: WriteContext): Promise<void> {
    await tx.update(refunds).set({ status: 'FAILED', updatedAt: this.clock.now() }).where(eq(refunds.id, refund.id));
    await this.audit.record(
      auditFrom(ctx, {
        action: 'refund.status_changed',
        entityType: 'refund',
        entityId: refund.id,
        summary: `Refund ${refund.id} marked FAILED: ${reason}`,
        before: { status: refund.status },
        after: { status: 'FAILED' },
      }),
      tx,
    );
  }
}
