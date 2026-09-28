/**
 * J3 · Risk composite (docs/03-agent-system.md §4 "J3", inside `riskAgent`, nodes.ts).
 *
 * Two pure, unit-tested steps live here so they never need a graph, a `DecisionPort` or a
 * database to test (CLAUDE.md rule 4: "models never do arithmetic or date math" — all of that
 * happens below, in code, before Jev ever sees a number):
 *
 *  1. `extractRiskSignals` reads the four risk tools' evidence facts (tools.ts) into one small
 *     numeric/boolean record.
 *  2. `bucketRiskSignals` turns those numbers into the descriptive bucket strings the doc's J3
 *     example shows (`"failed_attempts_24h_bucket": "6-10"`) — this is the `state` object
 *     `riskAgent` sends to Jev's J3 `score()` call. Jev never sees a raw count, only the bucket.
 *
 * `rulesOnlyRiskTier` is the J3 fallback (docs/03 §4 "Jev adapter contract": "J3 → rules-only
 * tier") used when `decision.ask` throws — a fixed, conservative weighting straight over the
 * raw signals, bypassing Jev entirely. See docs/DECISIONS.md for why this is a separate,
 * smaller function rather than reusing `core`'s `riskTierFromRules` (a different system: that
 * one is the policy engine's always-on risk input, computed from different data).
 */
import type { EvidenceItem } from '@payops/shared';
import type { RiskAssessment } from '@payops/shared';
import { tierForComposite } from './risk.weights';

function factsOf(evidence: readonly EvidenceItem[], source: string): EvidenceItem['facts'] {
  return evidence.find((e) => e.source === source)?.facts ?? {};
}

/** Raw numeric/boolean signals, one field per fact the four risk tools project (tools.ts). */
export interface RiskSignals {
  accountAgeDays: number;
  failed24h: number;
  total24h: number;
  cardCountriesDistinct: number;
  deviceCount: number;
  ipCardCountryMismatch: boolean;
  riskFlagsCount: number;
  merchantDisputeCount: number;
}

/** Step 1: evidence facts → numbers (docs §9 tool facts → this record). Missing evidence (a
 * tool that found nothing to project) reads as the least-risky value, never as "unknown treated
 * as dangerous" — an absent signal is not itself a signal. */
export function extractRiskSignals(evidence: readonly EvidenceItem[]): RiskSignals {
  const history = factsOf(evidence, 'getCustomerHistory');
  const device = factsOf(evidence, 'getDeviceSignals');
  const attempts = factsOf(evidence, 'getFailedAttempts');
  const chargebacks = factsOf(evidence, 'getChargebackHistory');
  return {
    accountAgeDays: Number(history.accountAgeDays ?? 3650), // no record at all reads as "long-established"
    riskFlagsCount: Number(history.riskFlagsCount ?? 0),
    failed24h: Number(attempts.failed24h ?? 0),
    total24h: Number(attempts.total24h ?? 0),
    cardCountriesDistinct: Number(device.cardCountriesDistinct ?? 0),
    deviceCount: Number(device.deviceCount ?? 0),
    ipCardCountryMismatch: Boolean(device.ipCardCountryMismatch ?? false),
    merchantDisputeCount: Number(chargebacks.merchantDisputeCount ?? 0),
  };
}

/** Step 2: numbers → descriptive buckets (docs §4 J3's own examples). This is the `state`
 * object `riskAgent` passes to `decision.ask` — Jev only ever reads bucket labels. */
export interface RiskBuckets {
  // Index signature so this satisfies the Jev SDK's `EntryType` state shape directly.
  [key: string]: string | boolean;
  account_age: string;
  failed_attempts_24h_bucket: string;
  card_countries: string;
  device_count: string;
  ip_card_country_mismatch: boolean;
  risk_flags: string;
  merchant_dispute_exposure: string;
}

function countBucket(n: number, edges: readonly [number, string][], overLabel: string): string {
  for (const [max, label] of edges) if (n <= max) return label;
  return overLabel;
}

export function bucketRiskSignals(s: RiskSignals): RiskBuckets {
  const accountAgeHours = s.accountAgeDays * 24;
  return {
    account_age:
      accountAgeHours < 24
        ? `created ${Math.max(1, Math.round(accountAgeHours))} hours ago`
        : s.accountAgeDays < 7
          ? '1 to 7 days old'
          : s.accountAgeDays < 30
            ? '7 to 30 days old'
            : 'over 30 days old',
    failed_attempts_24h_bucket: countBucket(
      s.failed24h,
      [
        [0, '0'],
        [2, '1-2'],
        [5, '3-5'],
        [10, '6-10'],
      ],
      '10+',
    ),
    card_countries: `${s.cardCountriesDistinct} distinct`,
    device_count: `${s.deviceCount} distinct`,
    ip_card_country_mismatch: s.ipCardCountryMismatch,
    risk_flags: s.riskFlagsCount === 0 ? 'none' : s.riskFlagsCount === 1 ? '1 flag' : `${s.riskFlagsCount} flags`,
    merchant_dispute_exposure: countBucket(
      s.merchantDisputeCount,
      [
        [0, '0'],
        [2, '1-2'],
      ],
      '3+',
    ),
  };
}

/** The four J3 Score criteria (0-3 rubrics), shared between the `score()` calls in nodes.ts and
 * this module's tests, so a test can assert the rubric text stays a 4-tuple. */
export const RISK_SCORE_CRITERIA = {
  velocity_abuse: [
    'Few or no failed attempts, on the usual device.',
    'A handful of failed attempts or a second device, within normal variation.',
    'Several failed attempts across more than one device or card in a short window.',
    'Many failed attempts across several devices and cards in a short window — looks automated.',
  ] as const,
  identity_mismatch: [
    'Established account, one card country, device IP matches the card country.',
    'A newer account, or one minor mismatch, nothing else unusual.',
    'A very new account combined with a device/card country mismatch.',
    'A brand-new account, multiple card countries and a device/card country mismatch together.',
  ] as const,
  chargeback_pattern: [
    'No risk flags recorded for this customer.',
    'One risk flag recorded, no other signal reinforcing it.',
    'One risk flag recorded alongside other risk signals on this payment.',
    'Multiple risk flags recorded for this customer.',
  ] as const,
  merchant_exposure: [
    'No settlement disputes recorded for this merchant recently.',
    'One or two settlement disputes recorded for this merchant recently.',
    'Several settlement disputes recorded for this merchant recently.',
    'A high number of settlement disputes recorded for this merchant recently.',
  ] as const,
};

/**
 * J3 fallback (docs/03 §4 "Jev adapter contract": "J3 → rules-only tier"), used when
 * `decision.ask` throws. Skips Jev and the weighted composite entirely: it scores each signal
 * against a fixed, conservative rubric in code and takes the worst one, so a single bad signal
 * is enough to raise the tier even without Jev's blended read. `meanConfidence` is reported as 0
 * so callers/UI can tell this assessment never went through Jev at all, distinct from a real low
 * Jev confidence (docs/DECISIONS.md).
 */
export function rulesOnlyRiskTier(s: RiskSignals): RiskAssessment {
  const worst = tierForComposite(
    Math.max(
      s.failed24h >= 6 || s.deviceCount >= 3 ? 3 : s.failed24h >= 3 || s.deviceCount >= 2 ? 2 : s.failed24h >= 1 ? 1 : 0,
      s.accountAgeDays < 1 && (s.cardCountriesDistinct >= 2 || s.ipCardCountryMismatch) ? 3 : s.accountAgeDays < 1 ? 2 : s.ipCardCountryMismatch ? 1 : 0,
      s.riskFlagsCount >= 2 ? 3 : s.riskFlagsCount === 1 ? 2 : 0,
      s.merchantDisputeCount >= 3 ? 2 : s.merchantDisputeCount >= 1 ? 1 : 0,
    ),
  );
  return {
    tier: worst,
    scores: {
      velocity_abuse: s.failed24h >= 6 ? 3 : s.failed24h >= 3 ? 2 : s.failed24h >= 1 ? 1 : 0,
      identity_mismatch: s.accountAgeDays < 1 ? (s.ipCardCountryMismatch ? 3 : 2) : s.ipCardCountryMismatch ? 1 : 0,
      chargeback_pattern: s.riskFlagsCount >= 2 ? 3 : s.riskFlagsCount === 1 ? 2 : 0,
      merchant_exposure: s.merchantDisputeCount >= 3 ? 2 : s.merchantDisputeCount >= 1 ? 1 : 0,
    },
    meanConfidence: 0,
  };
}
