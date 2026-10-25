/** Helpers shared by the graph nodes. */
import type { Core } from '@payops/core';
import type { AttemptHistory } from '@payops/core';
import {
  addBudgets,
  estimateCallCostUsd,
  zeroBudget,
  type AgentName,
  type AttemptSummary,
  type EvidenceItem,
  type Finding,
  type RootCause,
  type RunBudget,
} from '@payops/shared';
import type { DecisionPort, LlmPort } from '@payops/core';
import type { AgentEventSink } from '../deps';
import { checkBudgetGuard } from '../budget-guard';
import { nextEvidenceId, nextFindingId } from '../run-ids';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import type { ToolDef } from '../tools';

/** What every node builder receives. */
export interface NodeContext {
  core: Core;
  llm: LlmPort;
  decision: DecisionPort;
  onEvent: AgentEventSink;
  guardBudget: (nodeName: string, state: PayOpsStateType, update: PayOpsUpdate) => Promise<PayOpsUpdate>;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The budget guard (D049). Run after each node on the path to `policyGate`: when the run's total goes
 * over a limit the node still completes, and the graph routes to `closeEscalated` next.
 */
export function createBudgetGuard(onEvent: AgentEventSink): NodeContext['guardBudget'] {
  return async (nodeName, state, update) => {
    const total = addBudgets(state.budget ?? zeroBudget(), (update.budget ?? zeroBudget()) as RunBudget);
    const guard = checkBudgetGuard(total);
    if (!guard.exceeded) return update;
    await onEvent(nodeName, 'NODE_COMPLETED', { budgetExceeded: true, reason: guard.reason, budget: total });
    return { ...update, status: 'ESCALATED', error: guard.reason };
  };
}

/** Budget for one Jev call. */
export function jevBudget(usage: { input_tokens: number; output_tokens: number }): RunBudget {
  return {
    ...zeroBudget(),
    jevCalls: 1,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    costUsd: estimateCallCostUsd('jev', usage.input_tokens, usage.output_tokens),
  };
}

/** Budget when a Jev call failed: it still counts as a call, with no usage to price. */
export const failedJevBudget = (): RunBudget => ({ ...zeroBudget(), jevCalls: 1 });

/** `AttemptSummary` (agent state) to `AttemptHistory` (core input). Every entry comes from `replan`, which only runs after a validated attempt (D047), so the status is always VALIDATED. */
export function toAttemptHistory(history: readonly AttemptSummary[]): AttemptHistory[] {
  return history.map((h) => ({ actionTypes: h.actions.map((a) => a.type), status: 'VALIDATED', verdict: h.verdict }));
}

/** Turns tool drafts into evidence items with run-scoped ids. */
export function evidenceFrom(existing: readonly EvidenceItem[], drafts: ReadonlyArray<ReturnType<ToolDef['run']>>, stepId: string): EvidenceItem[] {
  const created: EvidenceItem[] = [];
  let pool = [...existing];
  for (const group of drafts) {
    for (const draft of group) {
      const item: EvidenceItem = { id: nextEvidenceId(pool), stepId, ...draft };
      created.push(item);
      pool = [...pool, item];
    }
  }
  return created;
}

interface FindingDraft {
  code: Finding['code'];
  statement: string;
  evidenceIds: string[];
  confidence: number;
}

/** A finding must cite evidence its own agent gathered: citations to other ids are dropped, and a finding left with none is discarded. */
export function buildFindings(drafts: readonly FindingDraft[], agent: AgentName, validIds: ReadonlySet<string>, existing: readonly Finding[]): Finding[] {
  let pool = [...existing];
  const findings: Finding[] = [];
  for (const draft of drafts) {
    const evidenceIds = draft.evidenceIds.filter((id) => validIds.has(id));
    if (evidenceIds.length === 0) continue;
    const finding: Finding = { id: nextFindingId(pool), agent, code: draft.code, statement: draft.statement, evidenceIds, confidence: draft.confidence };
    findings.push(finding);
    pool = [...pool, finding];
  }
  return findings;
}

export type { RootCause };
