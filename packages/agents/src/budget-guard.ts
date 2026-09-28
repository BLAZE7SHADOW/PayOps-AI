/**
 * Phase 5 task 5 (docs/06-phases.md): "Budget guard: exceeding `MAX_TOOL_CALLS` / `MAX_COST_USD`
 * per run escalates cleanly." Pure, no I/O -- `nodes.ts`'s `guardBudget` calls this after each
 * node on the pre-`policyGate` path (docs/DECISIONS.md D049 for exactly which nodes and why)
 * with the run's *cumulative* `RunBudget` (state so far plus that node's own update), and closes
 * the run through `closeEscalated` when it reports `exceeded: true`.
 */
import { AGENT_BUDGET_LIMITS, type RunBudget } from '@payops/shared';

export interface BudgetGuardResult {
  exceeded: boolean;
  /** Human-readable reason, set only when `exceeded` -- becomes `state.error` and the case's
   * audit summary (see `nodes.ts`'s `guardBudget`, `resolution.service.ts`'s
   * `escalateWithoutProposal`). */
  reason: string | null;
}

const okResult: BudgetGuardResult = { exceeded: false, reason: null };

/** Checked in limit order so the reason names whichever limit actually tripped first. */
export function checkBudgetGuard(budget: RunBudget): BudgetGuardResult {
  if (budget.toolCalls > AGENT_BUDGET_LIMITS.maxToolCalls) {
    return {
      exceeded: true,
      reason: `Budget guard: this run made ${budget.toolCalls} tool calls, over the ${AGENT_BUDGET_LIMITS.maxToolCalls} limit.`,
    };
  }
  if (budget.costUsd > AGENT_BUDGET_LIMITS.maxCostUsd) {
    return {
      exceeded: true,
      reason: `Budget guard: this run cost an estimated $${budget.costUsd.toFixed(4)}, over the $${AGENT_BUDGET_LIMITS.maxCostUsd.toFixed(2)} limit.`,
    };
  }
  return okResult;
}
