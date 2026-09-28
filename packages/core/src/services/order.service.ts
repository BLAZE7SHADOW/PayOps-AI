/**
 * Order writes. Every transition is checked against ORDER_TRANSITIONS and the optimistic `version`
 * column: the UPDATE only matches the version we read, so two writers cannot both win.
 */
import { and, eq } from 'drizzle-orm';
import { ORDER_TRANSITIONS, type OrderStatus } from '@payops/shared';
import type { Tx } from '../db/client';
import type { OrderRow } from '../db/rows';
import { orders, type OrderTransition } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';

export interface TransitionOptions {
  /** Timeline actor label, e.g. 'webhook-consumer', 'executor'. */
  by: string;
  reason?: string | null;
  /** Fail with VERSION_CONFLICT unless the order is still at this version. */
  expectedVersion?: number;
  /** Link the order to this internal payment as part of the transition. */
  paymentId?: string;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export class OrderService {
  constructor(
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  async transition(tx: Tx, orderId: string, to: OrderStatus, opts: TransitionOptions, ctx: WriteContext): Promise<OrderRow> {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw notFound('Order', orderId);
    if (!canTransition(order.status, to)) {
      throw new AppError('INVALID_TRANSITION', `Order ${orderId} cannot move from ${order.status} to ${to}`);
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== order.version) {
      throw versionConflict(orderId, opts.expectedVersion, order.version);
    }
    const now = this.clock.now();
    const step: OrderTransition = { at: now.toISOString(), from: order.status, to, by: opts.by, reason: opts.reason ?? null };
    const [updated] = await tx
      .update(orders)
      .set({
        status: to,
        version: order.version + 1,
        timeline: [...order.timeline, step],
        ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
        updatedAt: now,
      })
      .where(and(eq(orders.id, orderId), eq(orders.version, order.version)))
      .returning();
    if (!updated) throw versionConflict(orderId, order.version, null);
    await this.audit.record(
      auditFrom(ctx, {
        action: 'order.transitioned',
        entityType: 'order',
        entityId: orderId,
        summary: `Order ${orderId} moved ${order.status} to ${to} (by ${opts.by})${opts.reason ? `: ${opts.reason}` : ''}`,
        before: { status: order.status, version: order.version },
        after: { status: to, version: updated.version, paymentId: updated.paymentId },
      }),
      tx,
    );
    return updated;
  }
}

function versionConflict(orderId: string, expected: number, actual: number | null): AppError {
  return new AppError(
    'VERSION_CONFLICT',
    `Order ${orderId} changed while we were updating it (expected version ${expected}${actual === null ? '' : `, found ${actual}`})`,
  );
}
