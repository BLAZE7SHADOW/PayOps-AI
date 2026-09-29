/**
 * Resolution tables (Phase 2): one row per attempt to resolve a case, its approval, the executed
 * steps, the validator's verdict, and settlement disputes raised by the executor.
 */
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  APPROVAL_STATUS,
  RESOLUTION_STATUS,
  type ActorRef,
  type CatalogAction,
  type ExecutionRecordFact,
  type PolicyDecision,
  type ValidationCheck,
} from '@payops/shared';
import { createdAt, money, tstz, updatedAt } from './_columns';
import { cases } from './ops';

export const resolutions = pgTable(
  'resolutions',
  {
    id: text().primaryKey(),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    /** Agent run that proposed it (Phase 3). Null for manual resolutions. */
    runId: text(),
    attempt: integer().notNull(),
    actions: jsonb().$type<CatalogAction[]>().notNull(),
    rationale: text().notNull(),
    proposedBy: jsonb().$type<ActorRef>().notNull(),
    policy: jsonb().$type<PolicyDecision>().notNull(),
    status: text({ enum: RESOLUTION_STATUS }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.caseId, t.createdAt)],
);

export const APPROVAL_TIERS = ['OPS', 'MANAGER'] as const;

export const approvals = pgTable(
  'approvals',
  {
    id: text().primaryKey(),
    resolutionId: text()
      .notNull()
      .unique()
      .references(() => resolutions.id),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    tier: text({ enum: APPROVAL_TIERS }).notNull(),
    status: text({ enum: APPROVAL_STATUS }).notNull(),
    requestedBy: jsonb().$type<ActorRef>().notNull(),
    decidedBy: jsonb().$type<ActorRef | null>(),
    comment: text(),
    requestedAt: tstz().notNull(),
    decidedAt: tstz(),
  },
  (t) => [
    // At most one decision outstanding per case.
    uniqueIndex('approvals_one_pending_per_case_uq')
      .on(t.caseId)
      .where(sql`${t.status} = 'PENDING'`),
    index().on(t.status, t.requestedAt),
  ],
);

export const EXECUTION_STATUS = ['STARTED', 'SUCCEEDED', 'FAILED'] as const;

export interface ExecutionError {
  code: string;
  message: string;
}

export const executions = pgTable(
  'executions',
  {
    id: text().primaryKey(),
    /** sha256(resolutionId|actionIndex|type|stable-json(params)). Replays hit this constraint. */
    idempotencyKey: text().notNull().unique(),
    resolutionId: text()
      .notNull()
      .references(() => resolutions.id),
    caseId: text().notNull(),
    actionIndex: integer().notNull(),
    action: jsonb().$type<CatalogAction>().notNull(),
    status: text({ enum: EXECUTION_STATUS }).notNull(),
    summary: text().notNull().default(''),
    result: jsonb().$type<Record<string, unknown> | null>(),
    error: jsonb().$type<ExecutionError | null>(),
    /** Source records just before the action ran (D060), so the case page can show before and after. */
    before: jsonb().$type<ExecutionRecordFact[] | null>(),
    startedAt: tstz().notNull(),
    finishedAt: tstz(),
  },
  (t) => [index().on(t.resolutionId, t.actionIndex)],
);

export const VALIDATION_VERDICTS = ['PASS', 'PARTIAL', 'FAIL'] as const;

export const validationResults = pgTable(
  'validation_results',
  {
    id: text().primaryKey(),
    resolutionId: text()
      .notNull()
      .references(() => resolutions.id),
    caseId: text().notNull(),
    attempt: integer().notNull(),
    verdict: text({ enum: VALIDATION_VERDICTS }).notNull(),
    checks: jsonb().$type<ValidationCheck[]>().notNull(),
    at: tstz().notNull(),
  },
  (t) => [index().on(t.resolutionId, t.at)],
);

export const DISPUTE_STATUS = ['OPEN', 'WON', 'LOST'] as const;

/** Claims raised against the acquirer. Only settlement disputes exist so far. */
export const disputes = pgTable(
  'disputes',
  {
    id: text().primaryKey(),
    type: text({ enum: ['SETTLEMENT'] }).notNull(),
    batchId: text().notNull(),
    gwPaymentId: text(),
    amountMinor: money().notNull(),
    status: text({ enum: DISPUTE_STATUS }).notNull(),
    reason: text().notNull(),
    resolutionId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.batchId),
    // One open dispute per settlement batch.
    uniqueIndex('disputes_one_open_per_batch_uq')
      .on(t.batchId)
      .where(sql`${t.status} = 'OPEN'`),
  ],
);
