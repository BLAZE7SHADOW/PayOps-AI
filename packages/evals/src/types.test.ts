import { describe, expect, it } from 'vitest';
import { EVAL_THRESHOLDS, checkThresholds, summarize, type RunOutcome } from './types';

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
    toolsUsed: ['getGatewayPayment', 'getOrder'],
    toolSetMatch: true,
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

  it('returns null grounding figures when no run ever went through groundCheck', () => {
    const s = summarize([outcome(), outcome({ key: 'k2' })]);
    expect(s.runsWithDroppedFindingsRate).toBeNull();
    expect(s.droppedFindingsPerRun).toBeNull();
  });

  it('reports the share of full-path runs that dropped a finding, and the mean dropped per run', () => {
    // Fast-path runs (null) are ignored. Of the three full-path runs, two dropped something.
    const s = summarize([
      outcome({ groundingViolations: null }),
      outcome({ key: 'k2', groundingViolations: 2 }),
      outcome({ key: 'k3', groundingViolations: 1 }),
      outcome({ key: 'k4', groundingViolations: 0 }),
    ]);
    expect(s.runsWithDroppedFindingsRate).toBeCloseTo(2 / 3);
    expect(s.droppedFindingsPerRun).toBe(1);
  });

  it('computes the tool-set match rate only over runs that declared expected tools', () => {
    const s = summarize([
      outcome({ toolSetMatch: null }),
      outcome({ key: 'k2', toolSetMatch: true }),
      outcome({ key: 'k3', toolSetMatch: false }),
    ]);
    expect(s.toolSetMatchRate).toBeCloseTo(0.5);
    expect(summarize([outcome({ toolSetMatch: null })]).toolSetMatchRate).toBeNull();
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

describe('checkThresholds', () => {
  it('returns no messages when every aggregate is within its threshold', () => {
    expect(checkThresholds(summarize([outcome(), outcome({ key: 'k2' })]))).toEqual([]);
  });

  it('flags root-cause accuracy below the minimum', () => {
    const s = summarize([
      outcome({ rootCauseMatch: false }),
      outcome({ key: 'k2', rootCauseMatch: false }),
      outcome({ key: 'k3' }),
    ]);
    const messages = checkThresholds(s);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('root-cause accuracy');
    expect(messages[0]).toContain('33.3%');
  });

  it('flags action-set and tool-set match rates below their minimums', () => {
    const s = summarize([outcome({ actionSetMatch: false, toolSetMatch: false })]);
    const messages = checkThresholds(s);
    expect(messages.some((m) => m.includes('action-set match'))).toBe(true);
    expect(messages.some((m) => m.includes('tool-set match'))).toBe(true);
  });

  it('flags total cost above the cap', () => {
    const s = summarize([outcome({ costUsd: EVAL_THRESHOLDS.maxTotalCostUsd + 0.01 })]);
    expect(checkThresholds(s).some((m) => m.includes('total cost'))).toBe(true);
  });

  it('skips a rate that has nothing to measure instead of failing it', () => {
    const s = summarize([outcome({ actionSetMatch: null, toolSetMatch: null })]);
    expect(checkThresholds(s)).toEqual([]);
  });
});
