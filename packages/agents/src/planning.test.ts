import { describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '@payops/shared';
import { choosePlanSpecialists } from './planning';

const zeroNeeds = { payment: 0, reconciliation: 0, risk: 0 } as const;

describe('choosePlanSpecialists (J2 routing, docs/03 §4)', () => {
  it('runs all specialists when confidence in the primary hypothesis is below the safe-default floor', () => {
    const specialists = choosePlanSpecialists({ amountBand: 'LOW', primaryConfidence: 0.49, needScores: zeroNeeds });
    expect(specialists).toEqual([...AGENT_NAMES]);
  });

  it('routes a settlement_mismatch-shaped case to Reconciliation via the need_reconciliation Noul, not Payment-only', () => {
    const specialists = choosePlanSpecialists({
      amountBand: 'MEDIUM',
      primaryConfidence: 0.9,
      needScores: { payment: 0.1, reconciliation: 0.8, risk: 0.1 },
    });
    expect(specialists).toContain('reconciliation');
    expect(specialists).not.toEqual(['payment']);
  });

  it('includes a specialist once its need Noul reaches the 0.35 threshold, and excludes it just below', () => {
    const below = choosePlanSpecialists({ amountBand: 'LOW', primaryConfidence: 0.9, needScores: { payment: 0, reconciliation: 0.34, risk: 0 } });
    const at = choosePlanSpecialists({ amountBand: 'LOW', primaryConfidence: 0.9, needScores: { payment: 0, reconciliation: 0.35, risk: 0 } });
    expect(below).not.toContain('reconciliation');
    expect(at).toContain('reconciliation');
  });

  it('always includes Payment, even when its own need Noul is low', () => {
    const specialists = choosePlanSpecialists({ amountBand: 'LOW', primaryConfidence: 0.9, needScores: zeroNeeds });
    expect(specialists).toEqual(['payment']);
  });

  it('always includes Risk when the amount band is HIGH or above, even if need_risk is low', () => {
    const high = choosePlanSpecialists({ amountBand: 'HIGH', primaryConfidence: 0.9, needScores: zeroNeeds });
    const critical = choosePlanSpecialists({ amountBand: 'CRITICAL', primaryConfidence: 0.9, needScores: zeroNeeds });
    expect(high).toContain('risk');
    expect(critical).toContain('risk');
  });

  it('does not mandate Risk below the HIGH amount band', () => {
    const medium = choosePlanSpecialists({ amountBand: 'MEDIUM', primaryConfidence: 0.9, needScores: zeroNeeds });
    expect(medium).not.toContain('risk');
  });

  it('returns specialists in stable payment/reconciliation/risk order regardless of which Nouls fired', () => {
    const specialists = choosePlanSpecialists({
      amountBand: 'CRITICAL',
      primaryConfidence: 0.9,
      needScores: { payment: 0, reconciliation: 0.9, risk: 0 },
    });
    expect(specialists).toEqual(['payment', 'reconciliation', 'risk']);
  });
});
