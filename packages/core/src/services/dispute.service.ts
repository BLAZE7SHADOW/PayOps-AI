/** Settlement disputes raised against the acquirer. */
import { and, eq } from 'drizzle-orm';
import { formatMoney, newId } from '@payops/shared';
import type { DbOrTx, Tx } from '../db/client';
import type { DisputeRow } from '../db/rows';
import { disputes } from '../db/schema';
import { AppError } from '../errors';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';

export class DisputeService {
  constructor(
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  async openForBatch(db: DbOrTx, batchId: string): Promise<DisputeRow | null> {
    const [row] = await db.select().from(disputes).where(and(eq(disputes.batchId, batchId), eq(disputes.status, 'OPEN'))).limit(1);
    return row ?? null;
  }

  async raiseSettlement(
    tx: Tx,
    input: { batchId: string; gwPaymentId: string | null; amountMinor: number; reason: string; resolutionId: string | null },
    ctx: WriteContext,
  ): Promise<DisputeRow> {
    const existing = await this.openForBatch(tx, input.batchId);
    if (existing) throw new AppError('CONFLICT', `Batch ${input.batchId} already has an open dispute (${existing.id})`);
    const now = this.clock.now();
    const [row] = await tx
      .insert(disputes)
      .values({
        id: newId('dispute'),
        type: 'SETTLEMENT',
        batchId: input.batchId,
        gwPaymentId: input.gwPaymentId,
        amountMinor: input.amountMinor,
        status: 'OPEN',
        reason: input.reason,
        resolutionId: input.resolutionId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('dispute insert returned no row');
    await this.audit.record(
      auditFrom(ctx, {
        action: 'dispute.raised',
        entityType: 'settlement',
        entityId: input.batchId,
        summary: `Raised settlement dispute ${row.id} for ${formatMoney(row.amountMinor)} on batch ${input.batchId}: ${input.reason}`,
        after: { disputeId: row.id, amountMinor: row.amountMinor, gwPaymentId: input.gwPaymentId },
      }),
      tx,
    );
    return row;
  }
}
