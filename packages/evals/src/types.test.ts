import { describe, expect, it } from 'vitest';
import { summarize, type RunOutcome } from './types';

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    key: 'k',
    scenario: 's',
    ok: true,
    failures: [],
    status: 'RESOLVED',
    tier: 'AUTO',
    verdict: 'PASS',
    rootCause: 'WEBHOOK_PROCESSING_FAILURE',
    expectedRootCause: 'WEBHOOK_PROCESSING_FAILURE',
    rootCauseMatch: true,
    actionTypes: ['REPLAY_WEBHOOK_EVENT'],
    actionSetMatch: true,
    attempt: 1,
    replanned: false,
    toolCalls: 10,
    llmCalls: 0,
    jevCalls: 1,
    costUsd: 0.001,
    latencyMs: 200,
    groundingViolations: null,
    quarantineOk: null,
    ...overrides,
  };
}

describe('summarize', () => {
  it('reports 100% pass and accuracy when every run passes and matches', () => {
    const s = summarize([outcome(), outcome({ key: 'k2' })]);
    expect(s).toMatchObject({
      total: 2,
      passed: 2,
      failed: 0,
      rootCauseAccuracy: 1,
      actionSetMatchRate: 1,
    });
  });

  it('excludes runs with a knownRootCauseCaveat from root-cause accuracy', () => {
    const s = summarize([
      outcome(),
      outcome({
        key: 'k2',
        rootCauseMatch: false,
        knownRootCauseCaveat: 'documented model mismatch',
      }),
    ]);
    expect(s.rootCauseAccuracy).toBe(1); // only the non-caveat run is scored, and it matched
  });

  it('computes replan success rate only over runs that actually replanned', () => {
    const s = summarize([
      outcome({ replanned: false, status: 'RESOLVED' }),
      outcome({ key: 'k2', replanned: true, status: 'ESCALATED' }),
      outcome({ key: 'k3', replanned: true, status: 'RESOLVED' }),
    ]);
    expect(s.replanSuccessRate).toBeCloseTo(0.5);
  });

  it('returns null grounding violation rate when no run ever went through groundCheck', () => {
    const s = summarize([outcome(), outcome({ key: 'k2' })]);
    expect(s.groundingViolationRate).toBeNull();
  });

  it('averages grounding violations only across runs where grounding actually ran', () => {
    const s = summarize([
      outcome({ groundingViolations: null }),
      outcome({ key: 'k2', groundingViolations: 2 }),
      outcome({ key: 'k3', groundingViolations: 0 }),
    ]);
    expect(s.groundingViolationRate).toBe(1);
  });

  it('counts a failed hard gate towards failed, not passed', () => {
    const s = summarize([outcome({ ok: false, failures: ['tier mismatch'] })]);
    expect(s).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  it('sums cost across runs and averages tool calls/latency', () => {
    const s = summarize([
      outcome({ costUsd: 0.01, toolCalls: 10, latencyMs: 100 }),
      outcome({ key: 'k2', costUsd: 0.02, toolCalls: 20, latencyMs: 300 }),
    ]);
    expect(s.totalCostUsd).toBeCloseTo(0.03);
    expect(s.meanToolCalls).toBe(15);
    expect(s.meanLatencyMs).toBe(200);
  });
});
