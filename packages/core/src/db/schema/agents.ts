/**
 * Agent run tables (Phase 3): one row per LangGraph thread and one append-only row per event on
 * it (docs/03-agent-system.md §6, §16). `agentSteps` is what a reconnecting client rebuilds a
 * run's timeline from (`GET /api/runs/:id/steps`); LangGraph's own checkpoints (a separate
 * `checkpoints` schema managed by PostgresSaver) are what actually resumes execution.
 */
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import {
  AGENT_STEP_KINDS,
  RUN_PATHS,
  RUN_STATUS,
  type Diagnosis,
  type EvidenceItem,
  type Finding,
  type PolicyDecision,
  type ResolutionProposal,
  type RunBudget,
} from '@payops/shared';
import { createdAt, tstz, updatedAt } from './_columns';
import { cases } from './ops';
import { resolutions } from './resolution';

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text().primaryKey(),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    /** Set once the run proposes something (docs/03 §5 policyGate). */
    resolutionId: text().references(() => resolutions.id),
    approvalId: text(),
    status: text({ enum: RUN_STATUS }).notNull(),
    path: text({ enum: RUN_PATHS }),
    attempt: integer().notNull().default(1),
    /** RECORD/REPLAY cassette file, e.g. "captured_order_failed". Null in LIVE outside evals. */
    scenarioKey: text(),
    budget: jsonb().$type<RunBudget>().notNull(),
    evidence: jsonb().$type<EvidenceItem[]>().notNull().default([]),
    findings: jsonb().$type<Finding[]>().notNull().default([]),
    diagnosis: jsonb().$type<Diagnosis | null>(),
    proposal: jsonb().$type<ResolutionProposal | null>(),
    policy: jsonb().$type<PolicyDecision | null>(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: tstz(),
  },
  (t) => [index().on(t.caseId, t.createdAt), index().on(t.status)],
);

/** One row per realtime event (docs/03 §16), append-only, ordered by `seq` within a run. */
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => agentRuns.id),
    seq: integer().notNull(),
    node: text().notNull(),
    kind: text({ enum: AGENT_STEP_KINDS }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    at: tstz().notNull(),
  },
  (t) => [index().on(t.runId, t.seq)],
);

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentStepRow = typeof agentSteps.$inferSelect;
