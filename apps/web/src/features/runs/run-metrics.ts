import type { AgentRunItem, AgentStepItem, RunStatus } from '@payops/shared';
import type { Tone } from '../../lib/status';

/** Pure helpers for the Agent runs screens. All timing is computed here from timestamps, never by a model. */

export const RUN_TONE: Record<RunStatus, Tone> = {
  INVESTIGATING: 'accent',
  AWAITING_APPROVAL: 'warn',
  EXECUTING: 'accent',
  VALIDATING: 'accent',
  RESOLVED: 'ok',
  ESCALATED: 'bad',
  REJECTED: 'neutral',
  FAILED: 'bad',
};

/** Wall-clock run length. A run that has not finished is measured up to `nowMs`. */
export function runDurationMs(run: Pick<AgentRunItem, 'createdAt' | 'finishedAt'>, nowMs: number): number {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
  return Math.max(0, end - Date.parse(run.createdAt));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

export function formatCost(costUsd: number): string {
  return costUsd === 0 ? '$0' : `$${costUsd.toFixed(4)}`;
}

/**
 * Time spent in each node: NODE_STARTED to the next NODE_COMPLETED for the same node.
 * A node that runs in several attempts is summed. A node that never completed is left out.
 * Order is first appearance, which follows the graph.
 */
export function nodeLatencies(steps: AgentStepItem[]): Array<{ node: string; ms: number }> {
  const started = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (s.kind === 'NODE_STARTED') started.set(s.node, Date.parse(s.at));
    else if (s.kind === 'NODE_COMPLETED' && started.has(s.node)) {
      totals.set(s.node, (totals.get(s.node) ?? 0) + Math.max(0, Date.parse(s.at) - started.get(s.node)!));
      started.delete(s.node);
    }
  }
  return [...totals].map(([node, ms]) => ({ node, ms }));
}

/** Milliseconds since the previous step, or null for the first one. */
export function stepDeltas(steps: AgentStepItem[]): Map<number, number | null> {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const out = new Map<number, number | null>();
  sorted.forEach((s, i) => out.set(s.seq, i === 0 ? null : Math.max(0, Date.parse(s.at) - Date.parse(sorted[i - 1]!.at))));
  return out;
}

export function contextTokens(step: AgentStepItem): number | null {
  const n = step.payload.contextTokenEstimate;
  return typeof n === 'number' ? n : null;
}

/** Short label for what a step did: the Jev decision tag, the LLM call name, or the tools used. */
export function stepName(step: AgentStepItem): string {
  const p = step.payload;
  if (typeof p.tag === 'string') return p.tag;
  if (typeof p.call === 'string') return p.call;
  if (Array.isArray(p.tools)) return p.tools.join(', ');
  return '';
}

/** Anchor id of a step row in the recorded-events table; model-call links jump to it (P5 task 2). */
export const stepAnchorId = (seq: number) => `step-${seq}`;

export interface ModelCallRow {
  seq: number;
  node: string;
  /** "Gemini" for an LLM call, "Jev" for a typed decision. */
  provider: 'Gemini' | 'Jev';
  name: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Every Gemini and Jev call in a run, in order, with the token usage the adapter reported. */
export function modelCalls(steps: AgentStepItem[]): ModelCallRow[] {
  const rows: ModelCallRow[] = [];
  for (const s of steps) {
    if (s.kind !== 'LLM_CALLED' && s.kind !== 'DECISION_MADE') continue;
    const u = s.payload.usage;
    const usage = u && typeof u === 'object' ? (u as Record<string, unknown>) : {};
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    rows.push({
      seq: s.seq,
      node: s.node,
      provider: s.kind === 'LLM_CALLED' ? 'Gemini' : 'Jev',
      name: stepName(s),
      tokensIn: num(usage.inputTokens),
      tokensOut: num(usage.outputTokens),
    });
  }
  return rows;
}
