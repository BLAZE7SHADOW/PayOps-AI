/**
 * `estimateCallCostUsd` (docs/06-phases.md Phase 5 task 5, docs/DECISIONS.md D049) -- the pure
 * cost estimate `packages/agents/src/nodes.ts` uses on every LLM/Jev budget update, and
 * `checkBudgetGuard` (packages/agents/src/budget-guard.ts) compares against `AGENT_BUDGET_LIMITS.
 * maxCostUsd`. Only the arithmetic is tested here -- the guard logic itself is tested where it's
 * defined.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_BUDGET_LIMITS, COST_PER_1K_TOKENS_USD, estimateCallCostUsd } from './agents';

describe('estimateCallCostUsd', () => {
  it('is zero for zero tokens', () => {
    expect(estimateCallCostUsd('gemini', 0, 0)).toBe(0);
    expect(estimateCallCostUsd('jev', 0, 0)).toBe(0);
  });

  it('scales linearly with input and output tokens at each kind\'s own rate', () => {
    const gemini = COST_PER_1K_TOKENS_USD.gemini;
    expect(estimateCallCostUsd('gemini', 1000, 0)).toBeCloseTo(gemini.input);
    expect(estimateCallCostUsd('gemini', 0, 1000)).toBeCloseTo(gemini.output);
    expect(estimateCallCostUsd('gemini', 2000, 1000)).toBeCloseTo(gemini.input * 2 + gemini.output);

    const jev = COST_PER_1K_TOKENS_USD.jev;
    expect(estimateCallCostUsd('jev', 1000, 1000)).toBeCloseTo(jev.input + jev.output);
  });

  it('a single call has to use an unrealistic number of tokens to alone exceed maxCostUsd (sanity bound on the default limit)', () => {
    // A real call in this codebase's own budgets (context.ts's CONTEXT_BUDGET) never exceeds a
    // few thousand tokens -- confirms `maxCostUsd` isn't so tight that normal operation trips it.
    expect(estimateCallCostUsd('gemini', 5000, 2000)).toBeLessThan(AGENT_BUDGET_LIMITS.maxCostUsd);
    expect(estimateCallCostUsd('jev', 5000, 2000)).toBeLessThan(AGENT_BUDGET_LIMITS.maxCostUsd);
  });
});
