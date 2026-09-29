/**
 * Read side of resolutions: builds ResolutionItem DTOs (with approval, execution steps and the
 * latest validation) and the case page's resolution view. Batched: a constant number of queries
 * however many resolutions are shown.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  hasPermission,
  type ApprovalSummary,
  type CaseResolutionView,
  type ExecutionStep,
  type ResolutionItem,
  type SessionUser,
  type ValidationResultDto,
} from '@payops/shared';
import type { DbOrTx } from '../db/client';
import type { ApprovalRow, CaseRow, ExecutionRow, ResolutionRow, ValidationResultRow } from '../db/rows';
import { approvals, executions, resolutions, validationResults } from '../db/schema';
import { notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import { idempotencyKey } from '../actions/idempotency';
import { actionOptions, type AttemptHistory } from '../actions/options';
import { loadCaseState } from '../actions/state';
import { CLOSED_CASE_STATUSES } from './case.service';

export function toApprovalSummary(a: ApprovalRow): ApprovalSummary {
  return {
    id: a.id,
    tier: a.tier,
    status: a.status,
    decidedBy: a.decidedBy ?? null,
    comment: a.comment ?? null,
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  };
}

export function toValidationDto(v: ValidationResultRow): ValidationResultDto {
  return { id: v.id, verdict: v.verdict, checks: v.checks, at: v.at.toISOString() };
}

/** Persisted steps, plus SKIPPED placeholders for actions after a failed step. */
export function toExecutionSteps(resolution: ResolutionRow, rows: readonly ExecutionRow[]): ExecutionStep[] {
  const byIndex = new Map(rows.map((r) => [r.actionIndex, r]));
  const steps: ExecutionStep[] = [];
  let failedAt: string | null = null;
  resolution.actions.forEach((action, index) => {
    const row = byIndex.get(index);
    if (row) {
      steps.push({
        index,
        type: action.type,
        status: row.status,
        idempotencyKey: row.idempotencyKey,
        summary: row.summary,
        error: row.error ?? null,
        before: row.before ?? null,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      });
      if (row.status === 'FAILED') failedAt = (row.finishedAt ?? row.startedAt).toISOString();
    } else if (failedAt) {
      steps.push({
        index,
        type: action.type,
        status: 'SKIPPED',
        idempotencyKey: idempotencyKey(resolution.id, index, action),
        summary: 'Skipped because an earlier step failed',
        error: null,
        before: null,
        startedAt: failedAt,
        finishedAt: null,
      });
    }
  });
  return steps;
}

export class ResolutionQueryService {
  constructor(
    private readonly db: DbOrTx,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
  ) {}

  async row(id: string, db: DbOrTx = this.db): Promise<ResolutionRow> {
    const [row] = await db.select().from(resolutions).where(eq(resolutions.id, id)).limit(1);
    if (!row) throw notFound('Resolution', id);
    return row;
  }

  async item(id: string): Promise<ResolutionItem> {
    const [item] = await this.toItems([await this.row(id)]);
    if (!item) throw notFound('Resolution', id);
    return item;
  }

  async toItems(rows: readonly ResolutionRow[]): Promise<ResolutionItem[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [approvalRows, executionRows, validationRows] = await Promise.all([
      this.db.select().from(approvals).where(inArray(approvals.resolutionId, ids)),
      this.db.select().from(executions).where(inArray(executions.resolutionId, ids)),
      this.db.select().from(validationResults).where(inArray(validationResults.resolutionId, ids)).orderBy(desc(validationResults.at)),
    ]);
    const approvalBy = new Map(approvalRows.map((a) => [a.resolutionId, a]));
    const latestValidation = new Map<string, ValidationResultRow>();
    for (const v of validationRows) if (!latestValidation.has(v.resolutionId)) latestValidation.set(v.resolutionId, v);
    return rows.map((r) => {
      const approval = approvalBy.get(r.id);
      const validation = latestValidation.get(r.id);
      return {
        id: r.id,
        caseId: r.caseId,
        runId: r.runId,
        attempt: r.attempt,
        status: r.status,
        actions: r.actions,
        rationale: r.rationale,
        proposedBy: r.proposedBy,
        policy: r.policy,
        approval: approval ? toApprovalSummary(approval) : null,
        executions: toExecutionSteps(r, executionRows.filter((e) => e.resolutionId === r.id)),
        validation: validation ? toValidationDto(validation) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** Newest first. */
  async rowsForCase(caseId: string, db: DbOrTx = this.db): Promise<ResolutionRow[]> {
    return db.select().from(resolutions).where(eq(resolutions.caseId, caseId)).orderBy(desc(resolutions.createdAt), desc(resolutions.attempt));
  }

  async listForCase(caseId: string): Promise<ResolutionItem[]> {
    return this.toItems(await this.rowsForCase(caseId));
  }

  async pendingApproval(caseId: string, db: DbOrTx = this.db): Promise<ApprovalRow | null> {
    const [row] = await db.select().from(approvals).where(and(eq(approvals.caseId, caseId), eq(approvals.status, 'PENDING'))).limit(1);
    return row ?? null;
  }

  history(items: readonly ResolutionItem[]): AttemptHistory[] {
    return items.map((i) => ({ actionTypes: i.actions.map((a) => a.type), status: i.status, verdict: i.validation?.verdict ?? null }));
  }

  /** Why the viewer cannot propose now, or null if they can. */
  cannotProposeReason(
    row: Pick<CaseRow, 'status'>,
    items: readonly Pick<ResolutionItem, 'status'>[],
    pending: ApprovalRow | null,
    viewer: SessionUser | null,
  ): string | null {
    if (!viewer) return 'Sign in to propose a resolution.';
    if (!hasPermission(viewer.role, 'resolution.propose')) return `Your role (${viewer.role}) can view cases but not propose resolutions.`;
    if (CLOSED_CASE_STATUSES.includes(row.status)) return `This case is ${row.status}.`;
    if (pending) return 'A proposed resolution is waiting for approval.';
    if (items.some((i) => i.status === 'EXECUTING')) return 'A resolution is executing.';
    return null;
  }

  async view(row: CaseRow, viewer: SessionUser | null): Promise<CaseResolutionView> {
    const [state, items, pending] = await Promise.all([
      loadCaseState(this.db, this.gateway, row, this.clock.now()),
      this.listForCase(row.id),
      this.pendingApproval(row.id),
    ]);
    const reason = this.cannotProposeReason(row, items, pending, viewer);
    return {
      actionOptions: actionOptions(state, this.history(items)),
      resolutions: items,
      pendingApprovalId: pending?.id ?? null,
      canPropose: reason === null,
      cannotProposeReason: reason,
    };
  }
}
