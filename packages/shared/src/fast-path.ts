/**
 * Thresholds for the agent's fast path (D062). The `diagnose` node in `packages/agents` applies them
 * and the run page in `apps/web` explains them, so both import this one constant.
 */
export const FAST_PATH = {
  /** Jev's root-cause confidence must be at least this. */
  minConfidence: 0.8,
  /** Jev's "needs a person" score must be at most this. */
  maxNeedsHuman: 0.5,
  /** Jev's "evidence is consistent" score must be above this. */
  minConsistent: 0.5,
} as const;
