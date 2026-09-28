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
  groundingViolationRate: number | null; // mean violations among runs where grounding ran
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
  const grounded = outcomes.filter((o) => o.groundingViolations !== null);
  const groundingViolationRate = grounded.length
    ? grounded.reduce((sum, o) => sum + (o.groundingViolations ?? 0), 0) / grounded.length
    : null;
  return {
    total,
    passed,
    failed: total - passed,
    rootCauseAccuracy,
    actionSetMatchRate,
    replanSuccessRate,
    groundingViolationRate,
    meanToolCalls: total ? outcomes.reduce((s, o) => s + o.toolCalls, 0) / total : 0,
    meanLatencyMs: total ? outcomes.reduce((s, o) => s + o.latencyMs, 0) / total : 0,
    totalCostUsd: outcomes.reduce((s, o) => s + o.costUsd, 0),
  };
}
