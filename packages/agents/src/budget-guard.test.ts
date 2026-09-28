import { describe, expect, it } from 'vitest';
import { zeroBudget, type RunBudget } from '@payops/shared';
import { checkBudgetGuard } from './budget-guard';

const budget = (over: Partial<RunBudget>): RunBudget => ({ ...zeroBudget(), ...over });

describe('checkBudgetGuard (docs/06-phases.md Phase 5 task 5)', () => {
  it('passes a budget well within both limits', () => {
    expect(checkBudgetGuard(budget({ toolCalls: 20, costUsd: 0.001 }))).toEqual({ exceeded: false, reason: null });
  });

  it('passes exactly at either limit (only strictly over trips it)', () => {
    expect(checkBudgetGuard(budget({ toolCalls: 60, costUsd: 0.05 })).exceeded).toBe(false);
  });

  it('trips on tool calls over the limit and names the count and limit', () => {
    const result = checkBudgetGuard(budget({ toolCalls: 61, costUsd: 0 }));
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain('61 tool calls');
    expect(result.reason).toContain('60 limit');
  });

  it('trips on cost over the limit and names the estimate and limit', () => {
    const result = checkBudgetGuard(budget({ toolCalls: 0, costUsd: 0.0501 }));
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain('$0.0501');
    expect(result.reason).toContain('$0.05 limit');
  });

  it('checks tool calls first when both limits are tripped', () => {
    const result = checkBudgetGuard(budget({ toolCalls: 100, costUsd: 1 }));
    expect(result.reason).toContain('tool calls');
  });
});
