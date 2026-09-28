import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@payops/shared';
import { RISK_TIERS_AGENT } from '@payops/shared';
import { bucketRiskSignals, extractRiskSignals, rulesOnlyRiskTier, type RiskSignals } from './risk';
import { combineRiskScores, raiseTierByOne, tierForComposite } from './risk.weights';

function ev(source: string, facts: EvidenceItem['facts']): EvidenceItem {
  return { id: 'ev_01', source, system: 'RISK', entityRef: 'x', facts, observedAt: '2026-01-01T00:00:00.000Z', stepId: 'triage' };
}

const baseSignals: RiskSignals = {
  accountAgeDays: 400,
  failed24h: 0,
  total24h: 0,
  cardCountriesDistinct: 1,
  deviceCount: 1,
  ipCardCountryMismatch: false,
  riskFlagsCount: 0,
  merchantDisputeCount: 0,
};

describe('extractRiskSignals (docs/03 §4 J3: evidence facts → numbers)', () => {
  it('reads every risk tool fact by its source name', () => {
    const evidence = [
      ev('getCustomerHistory', { accountAgeDays: 0.1, riskFlagsCount: 2, riskFlags: 'a,b' }),
      ev('getDeviceSignals', { deviceCount: 3, cardCountriesDistinct: 2, primaryIpCountry: 'US', ipCardCountryMismatch: true }),
      ev('getFailedAttempts', { failed24h: 6, total24h: 9 }),
      ev('getChargebackHistory', { merchantDisputeCount: 4, note: 'proxy' }),
    ];
    expect(extractRiskSignals(evidence)).toEqual({
      accountAgeDays: 0.1,
      riskFlagsCount: 2,
      deviceCount: 3,
      cardCountriesDistinct: 2,
      ipCardCountryMismatch: true,
      failed24h: 6,
      total24h: 9,
      merchantDisputeCount: 4,
    });
  });

  it('treats a missing tool result as the least-risky value, not as an unknown-is-dangerous signal', () => {
    const signals = extractRiskSignals([]);
    expect(signals.failed24h).toBe(0);
    expect(signals.riskFlagsCount).toBe(0);
    expect(signals.ipCardCountryMismatch).toBe(false);
    expect(signals.accountAgeDays).toBeGreaterThan(300); // "long-established", not "brand new"
  });
});

describe('bucketRiskSignals (docs/03 §4 J3: numbers → descriptive buckets)', () => {
  it('buckets a brand-new account in hours, matching the doc\'s own example shape', () => {
    const buckets = bucketRiskSignals({ ...baseSignals, accountAgeDays: 2 / 24 });
    expect(buckets.account_age).toMatch(/^created \d+ hours ago$/);
  });

  it.each([
    [0, '0'],
    [2, '1-2'],
    [5, '3-5'],
    [10, '6-10'],
    [11, '10+'],
  ])('buckets %i failed attempts as "%s"', (failed24h, expected) => {
    expect(bucketRiskSignals({ ...baseSignals, failed24h }).failed_attempts_24h_bucket).toBe(expected);
  });

  it('renders distinct counts as "<n> distinct"', () => {
    const buckets = bucketRiskSignals({ ...baseSignals, cardCountriesDistinct: 3, deviceCount: 2 });
    expect(buckets.card_countries).toBe('3 distinct');
    expect(buckets.device_count).toBe('2 distinct');
  });

  it('passes the ip/card mismatch flag through unchanged', () => {
    expect(bucketRiskSignals({ ...baseSignals, ipCardCountryMismatch: true }).ip_card_country_mismatch).toBe(true);
  });

  it('buckets risk flags as none / 1 flag / N flags', () => {
    expect(bucketRiskSignals({ ...baseSignals, riskFlagsCount: 0 }).risk_flags).toBe('none');
    expect(bucketRiskSignals({ ...baseSignals, riskFlagsCount: 1 }).risk_flags).toBe('1 flag');
    expect(bucketRiskSignals({ ...baseSignals, riskFlagsCount: 3 }).risk_flags).toBe('3 flags');
  });

  it('buckets merchant dispute exposure as 0 / 1-2 / 3+', () => {
    expect(bucketRiskSignals({ ...baseSignals, merchantDisputeCount: 0 }).merchant_dispute_exposure).toBe('0');
    expect(bucketRiskSignals({ ...baseSignals, merchantDisputeCount: 2 }).merchant_dispute_exposure).toBe('1-2');
    expect(bucketRiskSignals({ ...baseSignals, merchantDisputeCount: 3 }).merchant_dispute_exposure).toBe('3+');
  });
});

describe('tierForComposite / raiseTierByOne (docs/03 §4 J3: weighted composite → tier)', () => {
  it('maps the four quartiles of the 0-3 composite range to LOW/MEDIUM/HIGH/CRITICAL', () => {
    expect(tierForComposite(0)).toBe('LOW');
    expect(tierForComposite(0.75)).toBe('LOW');
    expect(tierForComposite(1.0)).toBe('MEDIUM');
    expect(tierForComposite(1.5)).toBe('MEDIUM');
    expect(tierForComposite(2.0)).toBe('HIGH');
    expect(tierForComposite(2.25)).toBe('HIGH');
    expect(tierForComposite(3)).toBe('CRITICAL');
  });

  it('raises one level at a time and clamps at CRITICAL rather than wrapping', () => {
    expect(raiseTierByOne('LOW')).toBe('MEDIUM');
    expect(raiseTierByOne('HIGH')).toBe('CRITICAL');
    expect(raiseTierByOne('CRITICAL')).toBe('CRITICAL');
  });
});

describe('combineRiskScores (docs/03 §4 J3: risk = Σ wᵢ·scoreᵢ, then the confidence rule)', () => {
  const allZero = { velocity_abuse: 0, identity_mismatch: 0, chargeback_pattern: 0, merchant_exposure: 0 };
  const allThree = { velocity_abuse: 3, identity_mismatch: 3, chargeback_pattern: 3, merchant_exposure: 3 };

  it('is LOW when every score is 0 and confidence is high', () => {
    expect(combineRiskScores(allZero, 0.95)).toMatchObject({ tier: 'LOW', meanConfidence: 0.95 });
  });

  it('is CRITICAL when every score maxes out', () => {
    expect(combineRiskScores(allThree, 0.95).tier).toBe('CRITICAL');
  });

  it('weights velocity_abuse more heavily than merchant_exposure for the same raw score', () => {
    const velocityOnly = combineRiskScores({ ...allZero, velocity_abuse: 3 }, 0.9);
    const merchantOnly = combineRiskScores({ ...allZero, merchant_exposure: 3 }, 0.9);
    const composite = (r: typeof velocityOnly) => RISK_TIERS_AGENT.indexOf(r.tier);
    expect(composite(velocityOnly)).toBeGreaterThanOrEqual(composite(merchantOnly));
  });

  it('raises the tier by exactly one level when mean confidence is under 0.5 (uncertainty is treated as risk)', () => {
    const confident = combineRiskScores(allZero, 0.6);
    const unsure = combineRiskScores(allZero, 0.4);
    expect(confident.tier).toBe('LOW');
    expect(unsure.tier).toBe('MEDIUM');
  });

  it('clamps the confidence-raise at CRITICAL instead of throwing or wrapping', () => {
    const result = combineRiskScores(allThree, 0.1);
    expect(result.tier).toBe('CRITICAL');
  });
});

describe('rulesOnlyRiskTier (J3 fallback, docs/03 §4 "Jev adapter contract": "J3 → rules-only tier")', () => {
  it('is LOW for a clean signal set', () => {
    const result = rulesOnlyRiskTier(baseSignals);
    expect(result.tier).toBe('LOW');
    expect(result.meanConfidence).toBe(0); // marks this as a fallback assessment, not a real Jev read
  });

  it('a single severe signal is enough to raise the tier even without a blended Jev read', () => {
    const manyFailed = rulesOnlyRiskTier({ ...baseSignals, failed24h: 8 });
    expect(manyFailed.tier).not.toBe('LOW');
  });

  it('a brand-new account with a country mismatch is treated as high risk', () => {
    const result = rulesOnlyRiskTier({ ...baseSignals, accountAgeDays: 0.1, ipCardCountryMismatch: true, cardCountriesDistinct: 2 });
    expect(result.tier).toBe('CRITICAL');
  });

  it('never throws and always returns a complete RiskAssessment shape', () => {
    const result = rulesOnlyRiskTier(baseSignals);
    expect(Object.keys(result.scores).sort()).toEqual(['chargeback_pattern', 'identity_mismatch', 'merchant_exposure', 'velocity_abuse']);
  });
});
