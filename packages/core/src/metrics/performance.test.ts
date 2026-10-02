import { describe, expect, it } from 'vitest';
import { computePerformance, median } from './performance';

const t = (iso: string) => new Date(iso);

describe('median', () => {
  it('is null for no values, the middle for odd counts, the rounded mean of the middle two for even counts', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3); // 2.5 rounds to 3
  });
});

describe('computePerformance', () => {
  it('returns nulls, not zeros, when there is nothing to measure', () => {
    const m = computePerformance({ resolved: [], approvals: [], feedback: [], runs: [] });
    expect(m.resolutionTimeMedianMs).toBeNull();
    expect(m.autoResolutionRate).toBeNull();
    expect(m.agentAccuracy).toBeNull();
    expect(m.approvalTurnaroundMedianMs).toBeNull();
    expect(m.costPerCaseUsd).toBeNull();
  });

  it('computes each metric from rows', () => {
    const m = computePerformance({
      resolved: [
        { openedAt: t('2026-09-30T10:00:00Z'), resolvedAt: t('2026-09-30T10:10:00Z'), resolvedBy: 'AGENT' },
        { openedAt: t('2026-09-30T10:00:00Z'), resolvedAt: t('2026-09-30T11:00:00Z'), resolvedBy: 'USER' },
        { openedAt: t('2026-09-30T10:00:00Z'), resolvedAt: t('2026-09-30T10:30:00Z'), resolvedBy: null },
      ],
      approvals: [
        { requestedAt: t('2026-09-30T10:00:00Z'), decidedAt: t('2026-09-30T10:05:00Z') },
        { requestedAt: t('2026-09-30T10:00:00Z'), decidedAt: t('2026-09-30T10:15:00Z') },
        { requestedAt: t('2026-09-30T10:00:00Z'), decidedAt: t('2026-09-30T12:00:00Z') },
      ],
      feedback: [{ verdict: 'RIGHT' }, { verdict: 'RIGHT' }, { verdict: 'WRONG' }, { verdict: 'RIGHT' }],
      runs: [
        { caseId: 'c1', costUsd: 0.02 },
        { caseId: 'c1', costUsd: 0.01 },
        { caseId: 'c2', costUsd: 0.03 },
      ],
    });
    expect(m.resolutionTimeMedianMs).toBe(30 * 60_000);
    expect(m.resolvedCount).toBe(3);
    expect(m.autoResolutionRate).toBeCloseTo(1 / 3);
    expect(m.agentAccuracy).toBe(0.75);
    expect(m.ratedCount).toBe(4);
    expect(m.approvalTurnaroundMedianMs).toBe(15 * 60_000);
    expect(m.costPerCaseUsd).toBeCloseTo(0.03); // 0.06 over 2 distinct cases
    expect(m.casesWithRuns).toBe(2);
  });
});
