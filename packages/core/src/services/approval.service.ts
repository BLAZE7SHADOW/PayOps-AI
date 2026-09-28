/**
 * Approval queue and decisions. Enforces the role needed for the tier and four-eyes (whoever
 * proposed a resolution cannot approve it). On APPROVE the resolution continues through the
 * `onApproved` strategy: today that executes and validates it directly.
 */
import { and, count, desc, eq, lt, ne, or, type SQL } from 'drizzle-orm';
import {
  APPROVER_ROLE,
  ApprovalDecisionBody,
  OPS_EVENTS,
  ROOMS,
  roleAtLeast,
  type ApprovalDetail,
  type ApprovalItem,
  type ApprovalListQuery,
  type Page,
  type SessionUser,
} from '@payops/shared';
import type { Db } from '../db/client';
import type { ApprovalRow, CaseRow, ResolutionRow } from '../db/rows';
import { approvals, cases, resolutions } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { EventPublisherPort } from '../ports/events';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';
import { toCaseListItem, type CaseService } from './case.service';
import { decodeCursor, encodeCursor, isRecord } from './cursor';
import type { ResolutionQueryService } from './resolution-query.service';
import { actionsSummary, userActor, userWriteContext } from './resolution.service';

/** What happens after an approval. Phase 3 swaps in "resume the agent's LangGraph thread". */
export interface ApprovalContinuation {
  onApproved(resolution: ResolutionRow, write: WriteContext): Promise<void>;
}

/** Why this viewer cannot decide, or null if they can. */
export function cannotDecideReason(approval: ApprovalRow, resolution: ResolutionRow, viewer: SessionUser | null): string | null {
  if (approval.status !== 'PENDING') return `Already ${approval.status.toLowerCase()}.`;
  if (!viewer) return 'Sign in to decide.';
  const needed = APPROVER_ROLE[approval.tier];
  const allowed = needed === 'MANAGER' ? viewer.role === 'MANAGER' || viewer.role === 'ADMIN' : roleAtLeast(viewer.role, 'OPS');
  if (!allowed) return needed === 'MANAGER' ? 'Needs a manager.' : 'Needs an OPS user or above.';
  if (resolution.proposedBy.type === 'USER' && resolution.proposedBy.id === viewer.id) {
    return 'You proposed this resolution. Another person must approve it.';
  }
  return null;
}

interface ApprovalCursor {
  at: string;
  id: string;
}
const isApprovalCursor = (v: unknown): v is ApprovalCursor => isRecord(v) && typeof v.at === 'string' && typeof v.id === 'string';

export class ApprovalService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
    private readonly events: EventPublisherPort,
    private readonly cases: CaseService,
    private readonly queries: ResolutionQueryService,
    private readonly continuation: ApprovalContinuation,
  ) {}

  private toItem(a: ApprovalRow, c: CaseRow, r: ResolutionRow, viewer: SessionUser | null): ApprovalItem {
    const reason = cannotDecideReason(a, r, viewer);
    return {
      id: a.id,
      case: { id: c.id, displayId: c.displayId, type: c.type, status: c.status, amountMinor: c.amountMinor },
      resolutionId: r.id,
      tier: a.tier,
      status: a.status,
      actionsSummary: actionsSummary(r.actions),
      actionTypes: r.actions.map((x) => x.type),
      moneyMovingMinor: r.policy.moneyMovingMinor,
      riskTier: r.policy.riskTier,
      ruleIds: r.policy.reasons.map((x) => x.ruleId),
      requestedBy: a.requestedBy,
      requestedAt: a.requestedAt.toISOString(),
      decidedBy: a.decidedBy ?? null,
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      comment: a.comment ?? null,
      canDecide: reason === null,
      cannotDecideReason: reason,
    };
  }

  private async load(id: string): Promise<{ a: ApprovalRow; c: CaseRow; r: ResolutionRow }> {
    const [row] = await this.db
      .select({ a: approvals, c: cases, r: resolutions })
      .from(approvals)
      .innerJoin(cases, eq(cases.id, approvals.caseId))
      .innerJoin(resolutions, eq(resolutions.id, approvals.resolutionId))
      .where(eq(approvals.id, id))
      .limit(1);
    if (!row) throw notFound('Approval', id);
    return row;
  }

  /** Newest request first, keyset-paginated. */
  async list(query: ApprovalListQuery, viewer: SessionUser | null): Promise<Page<ApprovalItem>> {
    const filters: SQL[] = [];
    if (query.scope === 'pending') filters.push(eq(approvals.status, 'PENDING'));
    if (query.scope === 'decided') filters.push(ne(approvals.status, 'PENDING'));
    const cursor = decodeCursor(query.cursor, isApprovalCursor);
    const pageFilters = [...filters];
    if (cursor) {
      const at = new Date(cursor.at);
      pageFilters.push(or(lt(approvals.requestedAt, at), and(eq(approvals.requestedAt, at), lt(approvals.id, cursor.id))) as SQL);
    }
    const [rows, totals] = await Promise.all([
      this.db
        .select({ a: approvals, c: cases, r: resolutions })
        .from(approvals)
        .innerJoin(cases, eq(cases.id, approvals.caseId))
        .innerJoin(resolutions, eq(resolutions.id, approvals.resolutionId))
        .where(pageFilters.length ? and(...pageFilters) : undefined)
        .orderBy(desc(approvals.requestedAt), desc(approvals.id))
        .limit(query.limit + 1),
      this.db.select({ n: count() }).from(approvals).where(filters.length ? and(...filters) : undefined),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1]?.a;
    return {
      items: page.map((x) => this.toItem(x.a, x.c, x.r, viewer)),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.requestedAt.toISOString(), id: last.id }) : null,
      total: totals[0]?.n ?? 0,
    };
  }

  /** One approval as a list item (viewer-independent when viewer is null, e.g. for realtime fan-out). */
  async item(id: string, viewer: SessionUser | null = null): Promise<ApprovalItem> {
    const { a, c, r } = await this.load(id);
    return this.toItem(a, c, r, viewer);
  }

  async get(id: string, viewer: SessionUser | null): Promise<ApprovalDetail> {
    const { a, c, r } = await this.load(id);
    const [[caseItem], resolution] = await Promise.all([this.cases.listItems([c.id]), this.queries.item(r.id)]);
    return { ...this.toItem(a, c, r, viewer), resolution, caseItem: caseItem ?? toCaseListItem(c) };
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(approvals).where(eq(approvals.status, 'PENDING'));
    return row?.n ?? 0;
  }

  async decide(id: string, body: ApprovalDecisionBody, viewer: SessionUser): Promise<ApprovalItem> {
    const input = ApprovalDecisionBody.parse(body);
    const { a, c, r } = await this.load(id);
    const reason = cannotDecideReason(a, r, viewer);
    if (reason) throw new AppError(a.status !== 'PENDING' ? 'CONFLICT' : 'FORBIDDEN', reason);
    const write: WriteContext = { ...userWriteContext(viewer), caseId: c.id, runId: r.runId };

    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(approvals).where(eq(approvals.id, id)).for('update').limit(1);
      if (!locked || locked.status !== 'PENDING') throw new AppError('CONFLICT', 'This approval was already decided.');
      const now = this.clock.now();
      const status = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'ESCALATED';
      await tx
        .update(approvals)
        .set({ status, decidedBy: userActor(viewer), comment: input.comment || null, decidedAt: now })
        .where(eq(approvals.id, id));
      const resolutionStatus = input.decision === 'APPROVE' ? 'EXECUTING' : input.decision === 'REJECT' ? 'REJECTED' : 'ESCALATED';
      await tx.update(resolutions).set({ status: resolutionStatus, updatedAt: now }).where(eq(resolutions.id, r.id));
      await this.audit.record(
        auditFrom(write, {
          action: 'approval.decided',
          entityType: 'approval',
          entityId: id,
          summary: `${viewer.name} ${status.toLowerCase()} ${actionsSummary(r.actions)} for ${c.displayId}${input.comment ? `: ${input.comment}` : ''}`,
          before: { status: 'PENDING' },
          after: { status, comment: input.comment || null },
        }),
        tx,
      );
      const caseStatus = input.decision === 'APPROVE' ? 'EXECUTING' : input.decision === 'REJECT' ? 'OPEN' : 'ESCALATED';
      await this.cases.setStatus(tx, c.id, caseStatus, `${c.displayId}: approval ${status.toLowerCase()} by ${viewer.name}`, write);
    });

    const decided = await this.load(id);
    const payload = this.toItem(decided.a, decided.c, decided.r, null);
    this.events.publish(ROOMS.ops, OPS_EVENTS.approvalResolved, payload);
    this.events.publish(ROOMS.case(c.id), OPS_EVENTS.approvalResolved, payload);

    if (input.decision === 'APPROVE') await this.continuation.onApproved(decided.r, write);
    const after = await this.load(id);
    return this.toItem(after.a, after.c, after.r, viewer);
  }
}
