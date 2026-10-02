/**
 * Pure metric math for the Overview "Performance" block (P5 task 1, D079). Rows in, numbers out;
 * the service only fetches rows. Every metric has a stated definition in `METRIC_DEFINITIONS`,
 * (in `@payops/shared`, so the web shows them) and shown on the Overview page. Money is USD here only because model cost is tracked in USD.
 */
import type { PerformanceMetrics } from '@payops/shared';

export interface ResolvedCaseRow {
  openedAt: Date;
  resolvedAt: Date;
  resolvedBy: string | null;
}
export interface DecidedApprovalRow {
  requestedAt: Date;
  decidedAt: Date;
}
export interface FeedbackRow {
  verdict: 'RIGHT' | 'WRONG';
}
export interface RunCostRow {
  caseId: string;
  costUsd: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function computePerformance(input: {
  resolved: ResolvedCaseRow[];
  approvals: DecidedApprovalRow[];
  feedback: FeedbackRow[];
  runs: RunCostRow[];
}): PerformanceMetrics {
  const { resolved, approvals, feedback, runs } = input;
  const rated = feedback.length;
  const right = feedback.filter((f) => f.verdict === 'RIGHT').length;
  const casesWithRuns = new Set(runs.map((r) => r.caseId)).size;
  const spend = runs.reduce((acc, r) => acc + r.costUsd, 0);
  return {
    resolutionTimeMedianMs: median(resolved.map((c) => c.resolvedAt.getTime() - c.openedAt.getTime())),
    resolvedCount: resolved.length,
    autoResolutionRate: resolved.length ? resolved.filter((c) => c.resolvedBy === 'AGENT').length / resolved.length : null,
    agentAccuracy: rated ? right / rated : null,
    ratedCount: rated,
    approvalTurnaroundMedianMs: median(approvals.map((a) => a.decidedAt.getTime() - a.requestedAt.getTime())),
    decidedApprovalCount: approvals.length,
    costPerCaseUsd: casesWithRuns ? spend / casesWithRuns : null,
    casesWithRuns,
  };
}
