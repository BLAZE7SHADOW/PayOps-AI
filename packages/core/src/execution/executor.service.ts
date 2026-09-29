/**
 * Executes a resolution's actions in order. Every step:
 *   1. claims an `executions` row by idempotency key (a replay finds the stored result instead),
 *   2. re-checks preconditions on FRESH data (the world may have moved since the proposal),
 *   3. runs the handler, records SUCCEEDED/FAILED, audits and publishes.
 * Execution stops at the first FAILED step. Each step uses its own short transactions; nothing
 * here holds a transaction while calling the gateway.
 */
import { and, eq } from 'drizzle-orm';
import {
  ACTION_META,
  OPS_EVENTS,
  ROOMS,
  newId,
  type CatalogAction,
  type ExecutionRecordFact,
  type ExecutionStep,
} from '@payops/shared';
import type { Db } from '../db/client';
import type { ExecutionRow, ResolutionRow } from '../db/rows';
import { executions, type ExecutionError } from '../db/schema';
import { AppError } from '../errors';
import { withSerializationRetry } from '../db/retry';
import type { ClockPort } from '../ports/clock';
import type { EventPublisherPort } from '../ports/events';
import { idempotencyKey } from '../actions/idempotency';
import { executeAction, preconditionsOf } from '../actions/registry';
import { loadCaseState } from '../actions/state';
import type { ExecDeps } from '../actions/types';
import { projectCaseSourceRecords } from '../services/case-source-records';
import { auditFrom, type AuditService, type WriteContext } from '../services/audit.service';
import type { ResolutionQueryService } from '../services/resolution-query.service';
import { toExecutionSteps } from '../services/resolution-query.service';

export interface ExecutionOutcome {
  ok: boolean;
  steps: ExecutionStep[];
}

/** Compact copy of the source records, kept so the case page can show before and after (D060). */
function recordFacts(state: Parameters<typeof projectCaseSourceRecords>[0]): ExecutionRecordFact[] {
  return projectCaseSourceRecords(state).records.map((r) => ({
    system: r.system,
    kind: r.kind,
    id: r.id,
    status: r.status,
    amountMinor: r.amountMinor,
  }));
}

function toError(err: unknown): ExecutionError {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  return { code: 'EXECUTION_ERROR', message: err instanceof Error ? err.message : 'Unexpected error' };
}

export class ExecutorService {
  constructor(
    private readonly deps: ExecDeps,
    private readonly audit: AuditService,
    private readonly events: EventPublisherPort,
    private readonly queries: ResolutionQueryService,
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  private get clock(): ClockPort {
    return this.deps.clock;
  }

  async execute(resolutionId: string, write: WriteContext): Promise<ExecutionOutcome> {
    const resolution = await this.queries.row(resolutionId, this.db);
    const ctx: WriteContext = { ...write, caseId: resolution.caseId, runId: resolution.runId };
    let ok = true;
    for (const [index, action] of resolution.actions.entries()) {
      const row = await this.runStep(resolution, index, action, ctx);
      if (row.status !== 'SUCCEEDED') {
        ok = false;
        break;
      }
    }
    const rows = await this.db.select().from(executions).where(eq(executions.resolutionId, resolutionId));
    return { ok, steps: toExecutionSteps(resolution, rows) };
  }

  private async runStep(resolution: ResolutionRow, index: number, action: CatalogAction, ctx: WriteContext): Promise<ExecutionRow> {
    const key = idempotencyKey(resolution.id, index, action);
    const [claimed] = await this.db
      .insert(executions)
      .values({
        id: newId('execution'),
        idempotencyKey: key,
        resolutionId: resolution.id,
        caseId: resolution.caseId,
        actionIndex: index,
        action,
        status: 'STARTED',
        startedAt: this.clock.now(),
      })
      .onConflictDoNothing({ target: executions.idempotencyKey })
      .returning();
    if (!claimed) {
      // Replay of a step that already ran: return what happened, never act twice.
      const [existing] = await this.db.select().from(executions).where(eq(executions.idempotencyKey, key)).limit(1);
      if (!existing) throw new AppError('CONFLICT', `Execution ${key} vanished`);
      if (existing.status === 'STARTED') {
        throw new AppError('CONFLICT', `Step ${index + 1} (${ACTION_META[action.type].label}) is already executing`);
      }
      return existing;
    }
    this.publish(resolution.id);

    let status: 'SUCCEEDED' | 'FAILED';
    let summary: string;
    let result: Record<string, unknown> | null = null;
    let error: ExecutionError | null = null;
    let before: ExecutionRecordFact[] | null = null;
    try {
      const state = await loadCaseState(this.db, this.deps.gateway, resolution.caseId, this.clock.now());
      before = recordFacts(state);
      const failures = preconditionsOf(action, state);
      if (failures.length > 0) {
        status = 'FAILED';
        summary = `Not executed: ${failures[0]}`;
        error = { code: 'PRECONDITION_FAILED', message: failures.join(' ') };
      } else {
        const outcome = await executeAction(action, state, { deps: this.deps, write: ctx, resolutionId: resolution.id });
        status = 'SUCCEEDED';
        summary = outcome.summary;
        result = outcome.result;
      }
    } catch (err) {
      status = 'FAILED';
      error = toError(err);
      summary = `${ACTION_META[action.type].label} failed: ${error.message}`;
    }

    // Recording the outcome (not running the action -- that already happened above) is the one
    // write in this method that could plausibly see a genuine Postgres serialization failure
    // (docs/06-phases.md Phase 5 task 6): retried a couple of times in place since the whole
    // transaction is safe to redo from scratch (it only re-reads `status`/`summary`/`result`/
    // `error`, already computed above, and re-applies the same conditional update). Anything
    // other than a `40001`, or a `40001` that outlives the retries, still propagates -- the
    // caller (`execute`, below) has its own defined fallback for that (docs/DECISIONS.md, the
    // `nodes.ts` `execute` node's catch block).
    const row = await withSerializationRetry(() =>
      this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(executions)
          .set({ status, summary, result, error, before, finishedAt: this.clock.now() })
          .where(and(eq(executions.id, claimed.id), eq(executions.status, 'STARTED')))
          .returning();
        await this.audit.record(
          auditFrom(ctx, {
            action: 'action.executed',
            entityType: 'resolution',
            entityId: resolution.id,
            summary: `Step ${index + 1} ${ACTION_META[action.type].label}: ${status === 'SUCCEEDED' ? summary : `FAILED. ${summary}`}`,
            after: { index, type: action.type, status, idempotencyKey: key, error },
          }),
          tx,
        );
        return updated ?? claimed;
      }),
    );
    this.publish(resolution.id);
    return row;
  }

  private publish(resolutionId: string): void {
    // Fire and forget after commit; a failed read must never fail the execution.
    void this.queries
      .item(resolutionId)
      .then((item) => {
        this.events.publish(ROOMS.ops, OPS_EVENTS.resolutionUpdated, item);
        this.events.publish(ROOMS.case(item.caseId), OPS_EVENTS.resolutionUpdated, item);
      })
      .catch(() => undefined);
  }
}
