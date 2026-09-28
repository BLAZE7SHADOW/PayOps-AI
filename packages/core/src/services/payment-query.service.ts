/**
 * Read side of the payments explorer. Pages are selected with one keyset query, then every row
 * is built from batched OrderSnapshots, so the list's ledger / settlement / mismatch columns are
 * computed by the same code as the case page's state matrix.
 */
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import { escapeLike } from './like';
import type {
  LedgerState,
  Page,
  PaymentDetail,
  PaymentListItem,
  PaymentListQuery,
  SettlementState,
  StateMatrix,
} from '@payops/shared';
import type { Db } from '../db/client';
import type { PaymentRow } from '../db/rows';
import { gwPayments, orders, payments } from '../db/schema';
import { notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import { buildLifecycle } from '../reconciliation/lifecycle';
import { LEDGER_CODES, SETTLEMENT_CODES, buildMatrix } from '../reconciliation/matrix';
import type { OrderSnapshot } from '../reconciliation/snapshot';
import type { CaseService } from './case.service';
import { decodeCursor, encodeCursor, isRecord } from './cursor';
import { loadOrderSnapshots } from './snapshot.loader';

interface PaymentCursor {
  c: string;
  i: string;
}
const isPaymentCursor = (v: unknown): v is PaymentCursor =>
  isRecord(v) && typeof v.c === 'string' && typeof v.i === 'string';

/** Escapes LIKE wildcards so user input is matched literally. */

export function ledgerState(matrix: StateMatrix): LedgerState {
  const status = matrix.cells.LEDGER.status;
  if (status === LEDGER_CODES.posted) return 'POSTED';
  if (status === LEDGER_CODES.notExpected) return 'NOT_EXPECTED';
  return 'MISSING';
}

export function settlementState(matrix: StateMatrix): SettlementState {
  switch (matrix.cells.SETTLEMENT.status) {
    case SETTLEMENT_CODES.settled:
      return 'SETTLED';
    case SETTLEMENT_CODES.feeMismatch:
      return 'MISMATCH';
    case SETTLEMENT_CODES.pending:
      return 'PENDING';
    default:
      return 'NOT_EXPECTED';
  }
}

export class PaymentQueryService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
    private readonly cases: CaseService,
  ) {}

  /** Newest first, keyset-paginated on (createdAt, id). */
  async list(query: PaymentListQuery): Promise<Page<PaymentListItem>> {
    const conds: SQL[] = [];
    const q = query.q?.trim();
    if (q) {
      const pattern = `${escapeLike(q)}%`;
      conds.push(
        or(ilike(payments.id, pattern), ilike(payments.gwPaymentId, pattern), ilike(payments.orderId, pattern)) as SQL,
      );
    }
    if (query.gatewayStatus) {
      // Read-side filter on the gateway mirror table; writes still go only through the adapter.
      conds.push(
        inArray(
          payments.gwPaymentId,
          this.db.select({ id: gwPayments.id }).from(gwPayments).where(eq(gwPayments.status, query.gatewayStatus)),
        ),
      );
    }
    if (query.orderStatus) {
      conds.push(
        inArray(payments.orderId, this.db.select({ id: orders.id }).from(orders).where(eq(orders.status, query.orderStatus))),
      );
    }
    if (query.mismatchOnly) conds.push(eq(payments.mismatch, true));
    if (query.from) conds.push(gte(payments.createdAt, new Date(query.from)));
    if (query.to) conds.push(lte(payments.createdAt, new Date(query.to)));
    const cursor = decodeCursor(query.cursor, isPaymentCursor);
    if (cursor) {
      const c = new Date(cursor.c);
      conds.push(or(lt(payments.createdAt, c), and(eq(payments.createdAt, c), lt(payments.id, cursor.i))) as SQL);
    }

    const rows = await this.db
      .select()
      .from(payments)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items = await this.buildItems(page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ c: last.createdAt.toISOString(), i: last.id }) : null,
    };
  }

  /** Accepts our payment id or the gateway payment id. */
  async get(id: string): Promise<PaymentDetail> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(or(eq(payments.id, id), eq(payments.gwPaymentId, id)))
      .limit(1);
    if (!payment) throw notFound('Payment', id);
    const [snapshot] = await loadOrderSnapshots(this.db, this.gateway, [payment.orderId], this.clock.now());
    if (!snapshot) throw notFound('Payment', id);
    const openCases = await this.cases.openCasesByPayment([payment.id]);
    const { item, matrix } = this.toItem(payment, snapshot, openCases.get(payment.id) ?? null);
    const gw = snapshot.gateway.find((g) => g.id === payment.gwPaymentId);
    return {
      ...item,
      card: gw?.card ? { last4: gw.card.last4, network: gw.card.network, country: gw.card.country } : null,
      lifecycle: buildLifecycle(snapshot),
      matrix,
    };
  }

  private async buildItems(page: PaymentRow[]): Promise<PaymentListItem[]> {
    if (page.length === 0) return [];
    const [snapshots, openCases] = await Promise.all([
      loadOrderSnapshots(this.db, this.gateway, page.map((p) => p.orderId), this.clock.now()),
      this.cases.openCasesByPayment(page.map((p) => p.id)),
    ]);
    const byOrder = new Map(snapshots.map((s) => [s.order.id, s]));
    const items: PaymentListItem[] = [];
    for (const p of page) {
      const snapshot = byOrder.get(p.orderId);
      if (snapshot) items.push(this.toItem(p, snapshot, openCases.get(p.id) ?? null).item);
    }
    return items;
  }

  private toItem(
    payment: PaymentRow,
    snapshot: OrderSnapshot,
    openCase: { id: string; displayId: string } | null,
  ): { item: PaymentListItem; matrix: StateMatrix } {
    const view = snapshot.payment?.id === payment.id ? snapshot : { ...snapshot, payment };
    const matrix = buildMatrix(view);
    const gw = view.gateway.find((g) => g.id === payment.gwPaymentId) ?? view.primaryGw;
    return {
      matrix,
      item: {
        paymentId: payment.id,
        gwPaymentId: payment.gwPaymentId,
        orderId: payment.orderId,
        createdAt: payment.createdAt.toISOString(),
        customer: { id: view.customer.id, name: view.customer.name, emailMasked: view.customer.emailMasked },
        merchant: { id: view.merchant.id, name: view.merchant.name },
        amountMinor: payment.amountMinor,
        method: payment.method,
        gatewayStatus: gw?.status ?? 'CREATED',
        internalStatus: payment.status,
        orderStatus: view.order.status,
        ledger: ledgerState(matrix),
        settlement: settlementState(matrix),
        mismatch: matrix.mismatched.length > 0,
        openCase,
      },
    };
  }
}
