/**
 * Agent run tables (Phase 3): one row per LangGraph thread and one append-only row per event on
 * it (docs/03-agent-system.md §6, §16). `agentSteps` is what a reconnecting client rebuilds a
 * run's timeline from (`GET /api/runs/:id/steps`); LangGraph's own checkpoints (a separate
 * `checkpoints` schema managed by PostgresSaver) are what actually resumes execution.
 */
import { boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  AGENT_CONTROL_MODES,
  AGENT_STEP_KINDS,
  EVIDENCE_SYSTEMS,
  FEEDBACK_VERDICTS,
  FINDING_CODES,
  AGENT_NAMES,
  RUN_PATHS,
  ROOT_CAUSES,
  RUN_STATUS,
  type Diagnosis,
  type EvidenceItem,
  type Finding,
  type GroundingReport,
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
    /**
     * The run's final J4 grounding report (docs/03 §4a "J4"), Phase 4 task 8. Set once
     * `groundCheck` runs (full path only); stays null on the fast path, where `groundCheck` is
     * never reached, and null for a run created before this column existed. The web trace reads
     * this to strike through a dropped finding with its violation reason (docs/05 §9's "no
     * loud red for a muted state" -- see D044). Kept as one jsonb blob rather than a second
     * normalized table: a run has at most one grounding report, so there is nothing to query
     * across rows the way `agentFindings`/`evidence` (task 7) justify normalizing for.
     */
    grounding: jsonb().$type<GroundingReport | null>(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: tstz(),
  },
  (t) => [index().on(t.caseId, t.createdAt), index().on(t.status)],
);

/** The single row that holds the operator's agent switch (P1 task 4, D066). Id is always 'global'. */
export const agentControls = pgTable('agent_controls', {
  id: text().primaryKey(),
  mode: text({ enum: AGENT_CONTROL_MODES }).notNull(),
  reason: text().notNull().default(''),
  changedById: text().notNull(),
  changedByName: text().notNull(),
  updatedAt: updatedAt(),
});

/**
 * An operator's judgment of a run's diagnosis (P1 task 3, D065). One row per operator per run;
 * submitting again replaces it. `diagnosedRootCause` is copied from the run when judged.
 */
export const diagnosisFeedback = pgTable(
  'diagnosis_feedback',
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => agentRuns.id),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    diagnosedRootCause: text({ enum: ROOT_CAUSES }).notNull(),
    verdict: text({ enum: FEEDBACK_VERDICTS }).notNull(),
    reason: text().notNull().default(''),
    correctRootCause: text({ enum: ROOT_CAUSES }),
    givenById: text().notNull(),
    givenByName: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.runId, t.givenById), index().on(t.caseId)],
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


/**
 * One row per finding, normalized out of `agentRuns.findings` (docs/04-data-model.md's
 * `agent_findings` row: "runId, caseId, findingId, agent, code, statement, evidenceIds[],
 * confidence, grounded"). Added task 7 so the future trace UI (task 8) can select/join findings
 * directly instead of deserializing a whole run's jsonb blob -- `agentRuns.findings` itself is
 * kept as-is (D042): apps/server's `GET /api/runs/:id` and the web Investigation screen already
 * read it directly and neither is being migrated in this task, so the jsonb column and this
 * table are a deliberate, documented duplication of the same data for two different access
 * patterns (whole-run hydrate vs. per-finding query), not a half-finished migration.
 *
 * `findingId` ("fd_02", docs/03 §7) is only unique *within* a run, so the row's natural key is
 * the pair `(runId, findingId)` -- enforced by a `uniqueIndex`, following this schema's existing
 * house style for a generated-id table with a natural composite key (see `cases_open_fingerprint_uq`
 * in ops.ts, `disputes_one_open_per_batch_uq` in resolution.ts). `store.ts`'s upsert keys its
 * `ON CONFLICT` on this same pair, so re-syncing a run (resume, or an extra grounding round) never
 * duplicates or crashes on the constraint.
 *
 * `grounded`: computed by `store.ts` from `state.grounding` at sync time, not by the graph itself
 * (docs/DECISIONS.md D042). Semantics -- true only once J4 actually confirmed the finding wasn't
 * contradicted, false only on a real `GroundingViolation` naming this finding, and true by
 * default when grounding has not run at all yet for this finding (fast path, where `groundCheck`
 * never runs; or a finding written in the same sync as the run's terminal/interrupted state
 * before any `groundCheck` node has executed). A third "not yet checked" state was considered
 * (nullable boolean) and rejected: the doc's column list says plain `grounded` with no enum, and
 * "innocent until a violation names it" is exactly `groundCheck`'s own append-only drop model
 * (D041's `survivingFindings`) -- a finding is grounded until something concrete says otherwise.
 */
export const agentFindings = pgTable(
  'agent_findings',
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => agentRuns.id),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    /** "fd_02" -- stable within this run only, see the table doc comment above. */
    findingId: text().notNull(),
    agent: text({ enum: AGENT_NAMES }).notNull(),
    code: text({ enum: FINDING_CODES }).notNull(),
    statement: text().notNull(),
    evidenceIds: jsonb().$type<string[]>().notNull().default([]),
    confidence: real().notNull(),
    /** Default `true`: see the table doc comment -- "innocent until a violation names it". */
    grounded: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.runId), uniqueIndex('agent_findings_run_finding_uq').on(t.runId, t.findingId)],
);

/**
 * One row per evidence item, normalized out of `agentRuns.evidence` (docs/04-data-model.md's
 * `evidence` row: "runId, evidenceId, source, system, entityRef, facts, stepId"). Same rationale
 * and jsonb-coexistence tradeoff as `agentFindings` above (D042).
 *
 * `evidenceId` ("ev_03", docs/03 §7) is likewise only unique *within* a run, so this table's
 * natural key is `(runId, evidenceId)`, enforced the same way.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => agentRuns.id),
    /** "ev_03" -- stable within this run only, see the table doc comment above. */
    evidenceId: text().notNull(),
    source: text().notNull(),
    system: text({ enum: EVIDENCE_SYSTEMS }).notNull(),
    entityRef: text().notNull(),
    facts: jsonb().$type<Record<string, string | number | boolean>>().notNull().default({}),
    /** FK-ish link to `agent_steps` (docs/03 §7: "link to agentSteps for the raw payload") --
     * left as a plain text column, not a `.references()`, because a step can be pruned/rotated
     * independently in later phases and evidence should not become unreadable if it is. */
    stepId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.runId), uniqueIndex('evidence_run_evidence_uq').on(t.runId, t.evidenceId)],
);

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentStepRow = typeof agentSteps.$inferSelect;
export type AgentFindingRow = typeof agentFindings.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
