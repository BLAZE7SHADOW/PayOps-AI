import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { escapeLike } from './like';
import {
  CASE_DISPLAY_PREFIX,
  CASE_TYPE_LABEL,
  OPEN_CASE_STATUSES,
  dueAtFor,
  isOverdue,
  hasPermission,
  SEVERITY_RANK,
  caseDisplayId,
  formatMoney,
  newId,
  type CaseDetail,
  type CaseResolutionView,
  type SessionUser,
  type CaseListItem,
  type CaseListQuery,
  type CaseNote,
  type CaseStatus,
  type CaseType,
  type Page,
} from '@payops/shared';
import type { Db, DbOrTx, Tx } from '../db/client';
import type { CaseRow } from '../db/rows';
import { cases, counters, customers, merchants, supportNotes, users, type CaseResolutionRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import { priorityOf, type CaseCandidate } from '../reconciliation/candidates';
import { buildLifecycle } from '../reconciliation/lifecycle';
import { buildMatrix } from '../reconciliation/matrix';
import { SYSTEM_ACTOR, auditFrom, type AuditService, type WriteContext } from './audit.service';
import { decodeCursor, encodeCursor, isRecord } from './cursor';
import { loadOrderSnapshots } from './snapshot.loader';

/** Statuses that free the fingerprint (must match the partial unique index predicate). */
export const CLOSED_CASE_STATUSES: readonly CaseStatus[] = ['RESOLVED', 'REJECTED'];
/** Case types that may close themselves when the data reconciles (D069). */
const AUTO_CLOSE_CASE_TYPES: readonly CaseType[] = ['PAYMENT_MISMATCH', 'REFUND_EXCEPTION', 'DUPLICATE'];
const OPEN_FINGERPRINT_INDEX = 'cases_open_fingerprint_uq';

export interface OpenOrUpdateResult {
  case: CaseRow;
  created: boolean;
  /** True when something an analyst would notice changed (new case, new rules, severity). */
  changed: boolean;
}

interface CaseCursor {
  p: number;
  o: string;
  i: string;
}
const isCaseCursor = (v: unknown): v is CaseCursor =>
  isRecord(v) && typeof v.p === 'number' && typeof v.o === 'string' && typeof v.i === 'string';

/** Postgres unique violation on the one-open-case-per-fingerprint index. Drizzle wraps pg errors. */
export function isOpenFingerprintConflict(err: unknown): boolean {
  for (let e: unknown = err; isRecord(e); e = e.cause) {
    if (e.code === '23505' && e.constraint === OPEN_FINGERPRINT_INDEX) return true;
  }
  return false;
}

/** Audit action names for case status changes. */
const CASE_STATUS_ACTION: Record<CaseStatus, string> = {
  OPEN: 'case.reopened',
  INVESTIGATING: 'case.investigating',
  AWAITING_APPROVAL: 'case.awaiting_approval',
  EXECUTING: 'case.executing',
  RESOLVED: 'case.resolved',
  ESCALATED: 'case.escalated',
  REJECTED: 'case.rejected',
};

export class CaseService {
  /** Builds the resolution part of the case page. Injected so this service stays read/write only. */
  private resolutionViews: { view(row: CaseRow, viewer: SessionUser | null): Promise<CaseResolutionView> } | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
    private readonly audit: AuditService,
  ) {}

  /** Wired by the composition root (the resolution read side depends on this service's module). */
  useResolutionViews(views: { view(row: CaseRow, viewer: SessionUser | null): Promise<CaseResolutionView> }): void {
    this.resolutionViews = views;
  }

  /**
   * Opens a case for the candidate or merges it into the open case with the same fingerprint.
   * Must run inside a transaction; the audit row is written with the same `tx`.
   */
  async openOrUpdate(candidate: CaseCandidate, tx: Tx): Promise<OpenOrUpdateResult> {
    const existing = await this.findOpen(candidate.fingerprint, tx);
    if (existing) return this.merge(existing, candidate, tx);
    try {
      // Savepoint: a unique violation must not abort the surrounding transaction.
      const row = await tx.transaction((sp) => this.insert(candidate, sp));
      await this.audit.record(
        {
          ...SYSTEM_ACTOR,
          action: 'case.opened',
          entityType: 'case',
          entityId: row.id,
          caseId: row.id,
          summary: `Opened ${row.displayId}: ${CASE_TYPE_LABEL[row.type]} for ${formatMoney(row.amountMinor)} (${row.ruleIds.join(', ')})`,
          after: { severity: row.severity, ruleIds: row.ruleIds, mismatched: row.mismatched },
        },
        tx,
      );
      return { case: row, created: true, changed: true };
    } catch (err) {
      if (!isOpenFingerprintConflict(err)) throw err;
      // Another writer opened it between our read and insert: merge into theirs.
      const winner = await this.findOpen(candidate.fingerprint, tx);
      if (!winner) throw err;
      return this.merge(winner, candidate, tx);
    }
  }

  private async findOpen(fingerprint: string, tx: DbOrTx): Promise<CaseRow | undefined> {
    const [row] = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.fingerprint, fingerprint), notInArray(cases.status, [...CLOSED_CASE_STATUSES])))
      .for('update')
      .limit(1);
    return row;
  }

  private async nextDisplayId(candidate: CaseCandidate, tx: DbOrTx): Promise<string> {
    const prefix = CASE_DISPLAY_PREFIX[candidate.type];
    const [counter] = await tx
      .insert(counters)
      .values({ id: `case:${prefix}`, seq: 1 })
      .onConflictDoUpdate({ target: counters.id, set: { seq: sql`${counters.seq} + 1` } })
      .returning({ seq: counters.seq });
    return caseDisplayId(prefix, counter?.seq ?? 1);
  }

  private async insert(candidate: CaseCandidate, tx: DbOrTx): Promise<CaseRow> {
    const now = this.clock.now();
    const displayId = await this.nextDisplayId(candidate, tx);
    const [row] = await tx
      .insert(cases)
      .values({
        id: newId('case'),
        displayId,
        fingerprint: candidate.fingerprint,
        type: candidate.type,
        severity: candidate.severity,
        priority: candidate.priority,
        status: 'OPEN',
        amountMinor: candidate.amountMinor,
        ruleIds: candidate.ruleIds,
        matrix: candidate.matrix.cells,
        mismatched: candidate.matrix.mismatched,
        entityRefs: candidate.entityRefs,
        lastDetectedAt: now,
        openedAt: now,
        dueAt: dueAtFor(candidate.severity, now),
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('case insert returned no row');
    return row;
  }

  private async merge(existing: CaseRow, candidate: CaseCandidate, tx: Tx): Promise<OpenOrUpdateResult> {
    const ruleIds = [...new Set([...existing.ruleIds, ...candidate.ruleIds])].sort();
    const severity =
      SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity] ? candidate.severity : existing.severity;
    const rulesChanged = ruleIds.length !== existing.ruleIds.length;
    const changed =
      rulesChanged ||
      severity !== existing.severity ||
      candidate.matrix.mismatched.join() !== existing.mismatched.join();
    const [row] = await tx
      .update(cases)
      .set({
        ruleIds,
        severity,
        priority: priorityOf(severity, candidate.amountMinor),
        amountMinor: candidate.amountMinor,
        matrix: candidate.matrix.cells,
        mismatched: candidate.matrix.mismatched,
        entityRefs: { ...existing.entityRefs, ...candidate.entityRefs },
        lastDetectedAt: this.clock.now(),
        // Only a visible change bumps updatedAt, so the queue's "updated" column stays meaningful.
        updatedAt: changed ? this.clock.now() : existing.updatedAt,
      })
      .where(eq(cases.id, existing.id))
      .returning();
    if (!row) throw new Error(`case ${existing.id} vanished during update`);
    if (rulesChanged) {
      await this.audit.record(
        {
          ...SYSTEM_ACTOR,
          action: 'case.updated',
          entityType: 'case',
          entityId: row.id,
          caseId: row.id,
          summary: `${row.displayId} matched more rules: ${ruleIds.join(', ')}`,
          before: { ruleIds: existing.ruleIds, severity: existing.severity },
          after: { ruleIds, severity },
        },
        tx,
      );
    }
    return { case: row, created: false, changed };
  }

  /**
   * Moves a case to a new status inside the caller's transaction and audits it. Used by the
   * resolution flow (AWAITING_APPROVAL, EXECUTING, RESOLVED...) and the ESCALATE action.
   */
  async setStatus(
    tx: Tx,
    caseId: string,
    status: CaseStatus,
    summary: string,
    ctx: WriteContext,
    extra: { resolution?: CaseResolutionRow | null } = {},
  ): Promise<CaseRow> {
    const [existing] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1);
    if (!existing) throw notFound('Case', caseId);
    const now = this.clock.now();
    const closing = CLOSED_CASE_STATUSES.includes(status);
    const [row] = await tx
      .update(cases)
      .set({
        status,
        updatedAt: now,
        resolvedAt: status === 'RESOLVED' ? now : closing ? existing.resolvedAt : null,
        ...(extra.resolution !== undefined ? { resolution: extra.resolution } : {}),
      })
      .where(eq(cases.id, caseId))
      .returning();
    if (!row) throw notFound('Case', caseId);
    if (existing.status !== status) {
      await this.audit.record(
        auditFrom({ ...ctx, caseId }, {
          action: CASE_STATUS_ACTION[status],
          entityType: 'case',
          entityId: caseId,
          summary,
          before: { status: existing.status },
          after: { status, ...(extra.resolution ? { resolution: extra.resolution } : {}) },
        }),
        tx,
      );
    }
    return row;
  }

  /**
   * Closes OPEN cases whose order detection has just re-read and found fully consistent (D069).
   * The caller passes only orders with no rule hits and no mismatched system. Only plain
   * payment, refund and duplicate cases qualify: a case someone is investigating, approving,
   * executing or has escalated is theirs to close, and risk and settlement cases stay open
   * because "nothing flagged right now" does not prove a risk or a batch difference is gone.
   * Closes as RESOLVED by SYSTEM with a stated reason; returns the closed case ids.
   */
  async autoCloseReconciled(cleanOrderIds: readonly string[]): Promise<string[]> {
    if (cleanOrderIds.length === 0) return [];
    const candidates = await this.db
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.status, 'OPEN'),
          inArray(cases.type, [...AUTO_CLOSE_CASE_TYPES]),
          inArray(sql<string>`(${cases.entityRefs} ->> 'orderId')`, [...cleanOrderIds]),
        ),
      );
    const closed: string[] = [];
    for (const c of candidates) {
      const done = await this.db.transaction(async (tx) => {
        // Re-check under the row lock: someone may have picked the case up since the query.
        const [locked] = await tx.select({ status: cases.status }).from(cases).where(eq(cases.id, c.id)).for('update').limit(1);
        if (locked?.status !== 'OPEN') return false;
        await this.setStatus(
          tx,
          c.id,
          'RESOLVED',
          `${c.displayId}: closed automatically, all systems agree again`,
          { actor: SYSTEM_ACTOR, caseId: c.id },
          { resolution: { by: 'SYSTEM', summary: 'Reconciled without action: all systems agree again.', runId: null } },
        );
        return true;
      });
      if (done) {
        await this.refreshStoredMatrix(c.id);
        closed.push(c.id);
      }
    }
    return closed;
  }

  /**
   * Assigns an open case to an OPS-or-above user, or clears the assignee with `null`.
   * Same assignee twice is a no-op with no audit row. Audited as case.assigned / case.unassigned.
   */
  async assign(caseId: string, assigneeId: string | null, actor: Pick<SessionUser, 'id' | 'name'>): Promise<CaseListItem> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1);
      if (!existing) throw notFound('Case', caseId);
      if (!OPEN_CASE_STATUSES.includes(existing.status)) {
        throw new AppError('CONFLICT', `${existing.displayId} is ${existing.status.toLowerCase()} and cannot be reassigned`);
      }
      let assignee: { id: string; name: string } | null = null;
      if (assigneeId !== null) {
        const [u] = await tx.select().from(users).where(eq(users.id, assigneeId)).limit(1);
        if (!u) throw notFound('User', assigneeId);
        if (!hasPermission(u.role, 'case.assign')) {
          throw new AppError('VALIDATION_FAILED', `${u.name} cannot be assigned cases (needs the OPS role or above)`);
        }
        assignee = { id: u.id, name: u.name };
      }
      if ((existing.assigneeId ?? null) === assigneeId) return toCaseListItem(existing, assignee?.name ?? null, this.clock.now());

      const [previous] = existing.assigneeId
        ? await tx.select({ name: users.name }).from(users).where(eq(users.id, existing.assigneeId)).limit(1)
        : [];
      const [row] = await tx
        .update(cases)
        .set({ assigneeId, updatedAt: this.clock.now() })
        .where(eq(cases.id, caseId))
        .returning();
      if (!row) throw notFound('Case', caseId);
      await this.audit.record(
        {
          actorType: 'USER',
          actorId: actor.id,
          actorName: actor.name,
          action: assignee ? 'case.assigned' : 'case.unassigned',
          entityType: 'case',
          entityId: caseId,
          caseId,
          summary: assignee
            ? `Assigned ${row.displayId} to ${assignee.name}`
            : `Unassigned ${row.displayId}${previous ? ` (was ${previous.name})` : ''}`,
          before: { assigneeId: existing.assigneeId },
          after: { assigneeId },
        },
        tx,
      );
      return toCaseListItem(row, assignee?.name ?? null, this.clock.now());
    });
  }

  /** Queue order: priority desc, then oldest first. Keyset pagination. */
  async list(query: CaseListQuery): Promise<Page<CaseListItem>> {
    const filters: SQL[] = [];
    if (query.scope === 'open') filters.push(inArray(cases.status, [...OPEN_CASE_STATUSES]));
    if (query.scope === 'closed') filters.push(inArray(cases.status, [...CLOSED_CASE_STATUSES]));
    if (query.status) filters.push(eq(cases.status, query.status));
    if (query.type) filters.push(eq(cases.type, query.type));
    if (query.severity) filters.push(eq(cases.severity, query.severity));
    const now = this.clock.now();
    if (query.assigneeId === 'unassigned') filters.push(isNull(cases.assigneeId));
    else if (query.assigneeId) filters.push(eq(cases.assigneeId, query.assigneeId));
    if (query.overdue) {
      filters.push(inArray(cases.status, [...OPEN_CASE_STATUSES]), lt(cases.dueAt, now));
    }
    if (query.q) {
      const prefix = `${escapeLike(query.q)}%`;
      filters.push(
        or(
          ilike(cases.displayId, prefix),
          ilike(cases.id, prefix),
          ilike(sql`${cases.entityRefs} ->> 'paymentId'`, prefix),
          ilike(sql`${cases.entityRefs} ->> 'orderId'`, prefix),
        ) as SQL,
      );
    }

    const cursor = decodeCursor(query.cursor, isCaseCursor);
    const pageFilters = [...filters];
    if (cursor) {
      const openedAt = new Date(cursor.o);
      pageFilters.push(
        or(
          lt(cases.priority, cursor.p),
          and(eq(cases.priority, cursor.p), gt(cases.openedAt, openedAt)),
          and(eq(cases.priority, cursor.p), eq(cases.openedAt, openedAt), gt(cases.id, cursor.i)),
        ) as SQL,
      );
    }
    const [rows, totals] = await Promise.all([
      this.db
        .select({ row: cases, assigneeName: users.name })
        .from(cases)
        .leftJoin(users, eq(users.id, cases.assigneeId))
        .where(pageFilters.length ? and(...pageFilters) : undefined)
        .orderBy(desc(cases.priority), asc(cases.openedAt), asc(cases.id))
        .limit(query.limit + 1),
      this.db
        .select({ n: count() })
        .from(cases)
        .where(filters.length ? and(...filters) : undefined),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1]?.row;
    return {
      items: page.map((r) => toCaseListItem(r.row, r.assigneeName, now)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ p: last.priority, o: last.openedAt.toISOString(), i: last.id })
          : null,
      total: totals[0]?.n ?? 0,
    };
  }

  /** List items for specific cases (used to publish realtime updates). */
  async listItems(ids: readonly string[]): Promise<CaseListItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ row: cases, assigneeName: users.name })
      .from(cases)
      .leftJoin(users, eq(users.id, cases.assigneeId))
      .where(inArray(cases.id, [...ids]));
    const byId = new Map(rows.map((r) => [r.row.id, toCaseListItem(r.row, r.assigneeName, this.clock.now())]));
    return ids.map((id) => byId.get(id)).filter((c): c is CaseListItem => c !== undefined);
  }

  /** Highest-priority open case per internal payment id. */
  async openCasesByPayment(paymentIds: readonly string[]): Promise<Map<string, { id: string; displayId: string }>> {
    const out = new Map<string, { id: string; displayId: string }>();
    if (paymentIds.length === 0) return out;
    const paymentRef = sql<string>`${cases.entityRefs} ->> 'paymentId'`;
    const rows = await this.db
      .select({ id: cases.id, displayId: cases.displayId, paymentId: paymentRef })
      .from(cases)
      .where(and(inArray(paymentRef, [...paymentIds]), inArray(cases.status, [...OPEN_CASE_STATUSES])))
      .orderBy(desc(cases.priority), asc(cases.openedAt));
    for (const r of rows) if (!out.has(r.paymentId)) out.set(r.paymentId, { id: r.id, displayId: r.displayId });
    return out;
  }

  /**
   * Case detail with a LIVE matrix and lifecycle recomputed from current data, so the page
   * reflects fixes immediately. Settlement (batch) cases keep the matrix stored at detection.
   */
  /**
   * Store the live state matrix on a payment/order case. List views (queue, approvals) read the
   * stored matrix, so it must be refreshed after a resolution changes the underlying records.
   * Batch cases keep their detection-time matrix (D012).
   */
  async refreshStoredMatrix(caseId: string): Promise<void> {
    const [row] = await this.db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!row || row.type === 'SETTLEMENT_MISMATCH' || !row.entityRefs.orderId) return;
    const [snapshot] = await loadOrderSnapshots(this.db, this.gateway, [row.entityRefs.orderId], this.clock.now());
    if (!snapshot) return;
    const matrix = buildMatrix(snapshot);
    await this.db
      .update(cases)
      .set({ matrix: matrix.cells, mismatched: matrix.mismatched, updatedAt: this.clock.now() })
      .where(eq(cases.id, caseId));
  }

  async get(id: string, viewer: SessionUser | null = null): Promise<CaseDetail> {
    const [found] = await this.db
      .select({ row: cases, assigneeName: users.name })
      .from(cases)
      .leftJoin(users, eq(users.id, cases.assigneeId))
      .where(eq(cases.id, id))
      .limit(1);
    if (!found) throw notFound('Case', id);
    const { row } = found;
    const refs = row.entityRefs;

    const noteFilters: SQL[] = [];
    if (refs.paymentId) noteFilters.push(eq(supportNotes.paymentId, refs.paymentId));
    if (refs.orderId) noteFilters.push(eq(supportNotes.orderId, refs.orderId));

    const [snapshots, noteRows, customerRows, merchantRows, resolutionView] = await Promise.all([
      refs.orderId ? loadOrderSnapshots(this.db, this.gateway, [refs.orderId], this.clock.now()) : Promise.resolve([]),
      noteFilters.length
        ? this.db.select().from(supportNotes).where(or(...noteFilters)).orderBy(asc(supportNotes.createdAt))
        : Promise.resolve([]),
      refs.customerId
        ? this.db.select().from(customers).where(eq(customers.id, refs.customerId)).limit(1)
        : Promise.resolve([]),
      refs.merchantId
        ? this.db.select().from(merchants).where(eq(merchants.id, refs.merchantId)).limit(1)
        : Promise.resolve([]),
      this.resolutionViews ? this.resolutionViews.view(row, viewer) : Promise.resolve(emptyResolutionView()),
    ]);
    const snapshot = snapshots[0];
    const isBatchCase = row.type === 'SETTLEMENT_MISMATCH';
    const matrix =
      snapshot && !isBatchCase ? buildMatrix(snapshot) : { cells: row.matrix, mismatched: row.mismatched };
    const customer = customerRows[0];
    const merchant = merchantRows[0];

    return {
      ...toCaseListItem(row, found.assigneeName, this.clock.now()),
      mismatched: matrix.mismatched,
      matrix,
      entityRefs: {
        paymentId: refs.paymentId,
        gwPaymentId: refs.gwPaymentId,
        orderId: refs.orderId,
        customerId: refs.customerId,
        merchantId: refs.merchantId,
        refundId: refs.refundId,
        batchId: refs.batchId,
      },
      customer: customer ? { id: customer.id, name: customer.name, emailMasked: customer.emailMasked } : null,
      merchant: merchant ? { id: merchant.id, name: merchant.name } : null,
      notes: noteRows.map(
        (n): CaseNote => ({
          id: n.id,
          authorType: n.authorType,
          text: n.text,
          quarantined: n.quarantined,
          at: n.createdAt.toISOString(),
        }),
      ),
      lifecycle: snapshot ? buildLifecycle(snapshot) : [],
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolution: row.resolution ? { by: row.resolution.by, summary: row.resolution.summary } : null,
      resolutionView,
    };
  }
}

function emptyResolutionView(): CaseResolutionView {
  return { actionOptions: [], resolutions: [], pendingApprovalId: null, canPropose: false, cannotProposeReason: 'Resolution is not available.' };
}

export function toCaseListItem(row: CaseRow, assigneeName: string | null, now: Date): CaseListItem {
  const refs = row.entityRefs;
  const primaryRef: CaseListItem['primaryRef'] = {};
  if (refs.paymentId) primaryRef.paymentId = refs.paymentId;
  if (refs.orderId) primaryRef.orderId = refs.orderId;
  if (refs.batchId && row.type === 'SETTLEMENT_MISMATCH') primaryRef.batchId = refs.batchId;
  const signals: CaseListItem['signals'] = {};
  if (row.signals.complaintType != null) signals.complaintType = row.signals.complaintType;
  if (row.signals.urgent != null) signals.urgent = row.signals.urgent;
  if (row.signals.quarantined != null) signals.quarantined = row.signals.quarantined;
  return {
    id: row.id,
    displayId: row.displayId,
    type: row.type,
    severity: row.severity,
    priority: row.priority,
    status: row.status,
    amountMinor: row.amountMinor,
    ruleIds: row.ruleIds,
    mismatched: row.mismatched,
    signals,
    openedAt: row.openedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    assignee: row.assigneeId && assigneeName ? { id: row.assigneeId, name: assigneeName } : null,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    overdue: isOverdue(row.dueAt, OPEN_CASE_STATUSES.includes(row.status), now),
    primaryRef,
  };
}
