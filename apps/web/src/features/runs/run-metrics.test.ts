import { describe, expect, it } from 'vitest';
import type { AgentStepItem } from '@payops/shared';
import { contextTokens, formatCost, formatDuration, nodeLatencies, runDurationMs, stepDeltas, stepName } from './run-metrics';

const T0 = Date.parse('2026-09-29T10:00:00.000Z');
const step = (seq: number, node: string, kind: AgentStepItem['kind'], offsetMs: number, payload: Record<string, unknown> = {}): AgentStepItem => ({
  id: `s${seq}`, runId: 'run_1', seq, node, kind, payload, at: new Date(T0 + offsetMs).toISOString(),
});

describe('runDurationMs', () => {
  it('measures a finished run', () => {
    expect(runDurationMs({ createdAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 2500).toISOString() }, T0 + 99_999)).toBe(2500);
  });
  it('measures an unfinished run up to now', () => {
    expect(runDurationMs({ createdAt: new Date(T0).toISOString(), finishedAt: null }, T0 + 4000)).toBe(4000);
  });
});

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(820)).toBe('820 ms');
    expect(formatDuration(12_550)).toBe('12.6 s');
    expect(formatDuration(124_000)).toBe('2m 04s');
  });
});

describe('formatCost', () => {
  it('shows zero plainly and small costs to four places', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0007)).toBe('$0.0007');
  });
});

describe('nodeLatencies', () => {
  it('sums a node across attempts and skips unfinished nodes', () => {
    const steps = [
      step(1, 'triage', 'NODE_STARTED', 0),
      step(2, 'triage', 'NODE_COMPLETED', 300),
      step(3, 'resolve', 'NODE_STARTED', 300),
      step(4, 'resolve', 'NODE_COMPLETED', 1300),
      step(5, 'resolve', 'NODE_STARTED', 2000),
      step(6, 'resolve', 'NODE_COMPLETED', 2500),
      step(7, 'execute', 'NODE_STARTED', 2500),
    ];
    expect(nodeLatencies(steps)).toEqual([{ node: 'triage', ms: 300 }, { node: 'resolve', ms: 1500 }]);
  });
  it('returns nothing for no steps', () => {
    expect(nodeLatencies([])).toEqual([]);
  });
});

describe('stepDeltas', () => {
  it('is null for the first step and the gap for the rest, whatever the input order', () => {
    const d = stepDeltas([step(2, 'a', 'NODE_COMPLETED', 700), step(1, 'a', 'NODE_STARTED', 200)]);
    expect(d.get(1)).toBeNull();
    expect(d.get(2)).toBe(500);
  });
});

describe('step labels', () => {
  it('reads the context token estimate only when it is a number', () => {
    expect(contextTokens(step(1, 'n', 'LLM_CALLED', 0, { contextTokenEstimate: 812 }))).toBe(812);
    expect(contextTokens(step(1, 'n', 'LLM_CALLED', 0, { contextTokenEstimate: 'x' }))).toBeNull();
  });
  it('names a step by tag, then call, then tools', () => {
    expect(stepName(step(1, 'plan', 'DECISION_MADE', 0, { tag: 'J2_PLAN' }))).toBe('J2_PLAN');
    expect(stepName(step(1, 'a', 'LLM_CALLED', 0, { call: 'followUps' }))).toBe('followUps');
    expect(stepName(step(1, 'a', 'TOOL_COMPLETED', 0, { tools: ['getOrder', 'getLedger'] }))).toBe('getOrder, getLedger');
    expect(stepName(step(1, 'a', 'NODE_STARTED', 0))).toBe('');
  });
});
