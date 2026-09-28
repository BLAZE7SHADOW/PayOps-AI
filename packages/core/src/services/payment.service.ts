/** Writes to our internal payment records (not the gateway's). */
import { eq } from 'drizzle-orm';
import { formatMoney, type InternalPaymentStatus } from '@payops/shared';
import type { Tx } from '../db/client';
import type { PaymentRow } from '../db/rows';
import { payments } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';

export class PaymentService {
  constructor(
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  private async lock(tx: Tx, paymentId: string): Promise<PaymentRow> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!row) throw notFound('Payment', paymentId);
    return row;
  }

  /** Mirrors a gateway status onto our payment. No-op (returns null) when already equal. */
  async setStatus(tx: Tx, paymentId: string, status: InternalPaymentStatus, reason: string, ctx: WriteContext): Promise<PaymentRow | null> {
    const row = await this.lock(tx, paymentId);
    if (row.status === status) return null;
    const [updated] = await tx.update(payments).set({ status, updatedAt: this.clock.now() }).where(eq(payments.id, paymentId)).returning();
    await this.audit.record(
      auditFrom(ctx, {
        action: 'payment.status_changed',
        entityType: 'payment',
        entityId: paymentId,
        summary: `Internal payment ${paymentId} moved ${row.status} to ${status}: ${reason}`,
        before: { status: row.status },
        after: { status },
      }),
      tx,
    );
    return updated ?? null;
  }

  /** Freezes the payment so it is excluded from payouts until reviewed. */
  async hold(tx: Tx, paymentId: string, reason: string, ctx: WriteContext): Promise<PaymentRow> {
    const row = await this.lock(tx, paymentId);
    if (row.hold) throw new AppError('CONFLICT', `Payment ${paymentId} is already on hold`);
    const [updated] = await tx.update(payments).set({ hold: true, updatedAt: this.clock.now() }).where(eq(payments.id, paymentId)).returning();
    if (!updated) throw notFound('Payment', paymentId);
    await this.audit.record(
      auditFrom(ctx, {
        action: 'payment.held',
        entityType: 'payment',
        entityId: paymentId,
        summary: `Payment ${paymentId} (${formatMoney(row.amountMinor)}) put on hold: ${reason}`,
        before: { hold: false },
        after: { hold: true },
      }),
      tx,
    );
    return updated;
  }
}
