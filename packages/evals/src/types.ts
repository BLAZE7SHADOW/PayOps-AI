import type {
  ActionType,
  PolicyTier,
  RootCause,
  RunStatus,
  ValidationVerdict,
} from '@payops/shared';

/** One golden scenario's real outcome, checked against its `GoldenExpectation`. */
export interface RunOutcome {
  key: string;
  scenario: string;
  ok: boolean;
  failures: string[];
  status: RunStatus;
  tier: PolicyTier | null;
  verdict: ValidationVerdict | null;
  rootCause: RootCause | null;
  expectedRootCause: RootCause;
  rootCauseMatch: boolean;
  knownRootCauseCaveat?: string;
  actionTypes: ActionType[];
  actionSetMatch: boolean | null; // null when the golden scenario declares no allowedActionSets
  /** Distinct tool names that produced evidence in this run (evidence `source`). */
  toolsUsed: string[];
  /** Every `expectedTools` entry was used; null when the golden scenario declares none. Soft. */
  toolSetMatch: boolean | null;
  attempt: number;
  replanned: boolean;
  toolCalls: number;
  llmCalls: number;
  jevCalls: number;
  costUsd: number;
  latencyMs: number;
  groundingViolations: number | null; // null when groundCheck never ran (fast path)
  quarantineOk: boolean | null; // null when the scenario declares no expectQuarantinedNoteIncluding
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  rootCauseAccuracy: number; // 0..1, excludes runs with a knownRootCauseCaveat
  actionSetMatchRate: number | null;
  replanSuccessRate: number | null; // resolved / (replanned scenarios), null if none replanned
  toolSetMatchRate: number | null;
  /** Share of runs where groundCheck ran (full path) and dropped at least one finding. */
  runsWithDroppedFindingsRate: number | null;
  /** Mean findings dropped per run, over the runs where groundCheck ran. */
  droppedFindingsPerRun: number | null;
  meanToolCalls: number;
  meanLatencyMs: number;
  totalCostUsd: number;
}

export function summarize(outcomes: readonly RunOutcome[]): EvalSummary {
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.ok).length;
  const rootCauseScored = outcomes.filter((o) => !o.knownRootCauseCaveat);
  const rootCauseAccuracy = rootCauseScored.length
    ? rootCauseScored.filter((o) => o.rootCauseMatch).length / rootCauseScored.length
    : 1;
  const actionSetScored = outcomes.filter((o) => o.actionSetMatch !== null);
  const actionSetMatchRate = actionSetScored.length
    ? actionSetScored.filter((o) => o.actionSetMatch).length / actionSetScored.length
    : null;
  const replanned = outcomes.filter((o) => o.replanned);
  const replanSuccessRate = replanned.length
    ? replanned.filter((o) => o.status === 'RESOLVED').length / replanned.length
    : null;
  const toolSetScored = outcomes.filter((o) => o.toolSetMatch !== null);
  const toolSetMatchRate = toolSetScored.length
    ? toolSetScored.filter((o) => o.toolSetMatch).length / toolSetScored.length
    : null;
  const grounded = outcomes.filter((o) => o.groundingViolations !== null);
  const runsWithDroppedFindingsRate = grounded.length
    ? grounded.filter((o) => (o.groundingViolations ?? 0) > 0).length / grounded.length
    : null;
  const droppedFindingsPerRun = grounded.length
    ? grounded.reduce((sum, o) => sum + (o.groundingViolations ?? 0), 0) / grounded.length
    : null;
  return {
    total,
    passed,
    failed: total - passed,
    rootCauseAccuracy,
    actionSetMatchRate,
    replanSuccessRate,
    toolSetMatchRate,
    runsWithDroppedFindingsRate,
    droppedFindingsPerRun,
    meanToolCalls: total ? outcomes.reduce((s, o) => s + o.toolCalls, 0) / total : 0,
    meanLatencyMs: total ? outcomes.reduce((s, o) => s + o.latencyMs, 0) / total : 0,
    totalCostUsd: outcomes.reduce((s, o) => s + o.costUsd, 0),
  };
}

/**
 * Aggregate limits for a whole eval run. Per-scenario hard gates (status, verdict, tier, forbidden
 * actions) already fail a run; these catch a slow slide that no single scenario trips, such as
 * accuracy drifting down or cost creeping up. Latency is not limited because REPLAY latency is
 * not a real measurement.
 */
export const EVAL_THRESHOLDS = {
  minRootCauseAccuracy: 0.8,
  minActionSetMatchRate: 0.8,
  minToolSetMatchRate: 0.8,
  maxTotalCostUsd: 0.1,
} as const;

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Returns one plain message per aggregate that crosses its limit. Empty means the run is healthy.
 * A rate with nothing to measure (null) is skipped, never failed. */
export function checkThresholds(summary: EvalSummary, limits = EVAL_THRESHOLDS): string[] {
  const messages: string[] = [];
  if (summary.rootCauseAccuracy < limits.minRootCauseAccuracy)
    messages.push(
      `root-cause accuracy ${pct1(summary.rootCauseAccuracy)} is below the ${pct1(limits.minRootCauseAccuracy)} minimum`,
    );
  if (summary.actionSetMatchRate !== null && summary.actionSetMatchRate < limits.minActionSetMatchRate)
    messages.push(
      `action-set match ${pct1(summary.actionSetMatchRate)} is below the ${pct1(limits.minActionSetMatchRate)} minimum`,
    );
  if (summary.toolSetMatchRate !== null && summary.toolSetMatchRate < limits.minToolSetMatchRate)
    messages.push(
      `tool-set match ${pct1(summary.toolSetMatchRate)} is below the ${pct1(limits.minToolSetMatchRate)} minimum`,
    );
  if (summary.totalCostUsd > limits.maxTotalCostUsd)
    messages.push(
      `total cost $${summary.totalCostUsd.toFixed(4)} is above the $${limits.maxTotalCostUsd.toFixed(2)} cap`,
    );
  return messages;
}
