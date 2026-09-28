/**
 * Table-driven coverage of every `FindingCode` predicate (docs/03-agent-system.md §7), one
 * matching (predicate should hold) and one non-matching (predicate should fail) evidence set per
 * code, so a new `FindingCode` added later without a matching predicate case here is an obvious
 * gap rather than a silent one.
 */
import { describe, expect, it } from 'vitest';
import { FINDING_CODES, type EvidenceItem, type FindingCode } from '@payops/shared';
import { FINDING_PREDICATES } from './predicates';

let n = 0;
function ev(partial: Partial<EvidenceItem> & Pick<EvidenceItem, 'system' | 'facts'>): EvidenceItem {
  n += 1;
  return {
    id: `ev_${n}`,
    source: 'test',
    entityRef: `ent_${n}`,
    observedAt: '2026-01-01T00:00:00Z',
    stepId: 'test',
    ...partial,
  };
}

const CASES: Record<FindingCode, { matching: EvidenceItem[]; nonMatching: EvidenceItem[] }> = {
  WEBHOOK_HTTP_500: {
    matching: [ev({ system: 'WEBHOOK', facts: { finalStatus: 'FAILED', lastHttpStatus: 500 } })],
    nonMatching: [ev({ system: 'WEBHOOK', facts: { finalStatus: 'DELIVERED', lastHttpStatus: 200 } })],
  },
  WEBHOOK_UNDELIVERED: {
    matching: [ev({ system: 'WEBHOOK', facts: { finalStatus: 'FAILED', lastHttpStatus: 0 } })],
    nonMatching: [ev({ system: 'WEBHOOK', facts: { finalStatus: 'DELIVERED', lastHttpStatus: 200 } })],
  },
  ORDER_STATE_DIVERGED: {
    matching: [ev({ system: 'GATEWAY', facts: { status: 'CAPTURED' } }), ev({ system: 'ORDER', facts: { status: 'PENDING' } })],
    nonMatching: [ev({ system: 'GATEWAY', facts: { status: 'CAPTURED' } })],
  },
  LEDGER_CREDIT_MISSING: {
    matching: [ev({ system: 'GATEWAY', facts: { status: 'CAPTURED' } })],
    nonMatching: [ev({ system: 'GATEWAY', facts: { status: 'CAPTURED' } }), ev({ system: 'LEDGER', facts: { direction: 'CREDIT', account: 'CUSTOMER_RECEIVABLE' } })],
  },
  DUPLICATE_CAPTURE_DETECTED: {
    matching: [ev({ system: 'GATEWAY', entityRef: 'gw_1', facts: { status: 'CAPTURED' } }), ev({ system: 'GATEWAY', entityRef: 'gw_2', facts: { status: 'CAPTURED' } })],
    nonMatching: [ev({ system: 'GATEWAY', entityRef: 'gw_1', facts: { status: 'CAPTURED' } })],
  },
  REFUND_STATUS_MISMATCH: {
    matching: [
      ev({ system: 'REFUND', source: 'getRefund', facts: { status: 'PENDING' } }),
      ev({ system: 'REFUND', source: 'getRefundGatewayStatus', facts: { status: 'PROCESSED' } }),
    ],
    nonMatching: [ev({ system: 'REFUND', source: 'getRefund', facts: { status: 'PENDING' } })],
  },
  REFUND_MISSING: {
    matching: [ev({ system: 'ORDER', facts: { status: 'CANCELLED' } })],
    nonMatching: [ev({ system: 'ORDER', facts: { status: 'CANCELLED' } }), ev({ system: 'REFUND', source: 'getRefund', facts: { status: 'REQUESTED' } })],
  },
  REFUND_FAILED: {
    matching: [ev({ system: 'REFUND', facts: { status: 'FAILED' } })],
    nonMatching: [ev({ system: 'REFUND', facts: { status: 'PROCESSED' } })],
  },
  SETTLEMENT_FEE_DIFF: {
    matching: [ev({ system: 'SETTLEMENT', source: 'getFeeBreakdown', facts: { matched: false, diffMinor: 500 } })],
    nonMatching: [ev({ system: 'SETTLEMENT', source: 'getFeeBreakdown', facts: { matched: true, diffMinor: 0 } })],
  },
  SETTLEMENT_LINE_MISSING: {
    matching: [ev({ system: 'SETTLEMENT', source: 'getFeeBreakdown', facts: {} })],
    nonMatching: [ev({ system: 'SETTLEMENT', source: 'getFeeBreakdown', facts: {} }), ev({ system: 'SETTLEMENT', source: 'getSettlementLines', facts: { lineNo: 1 } })],
  },
  RISK_SIGNAL: {
    matching: [ev({ system: 'RISK', facts: { accountAgeDays: 1 } })],
    nonMatching: [],
  },
  OTHER: {
    matching: [],
    nonMatching: [],
  },
};

describe('FINDING_PREDICATES (docs/03 §7 "Structural grounding")', () => {
  it('covers every FindingCode', () => {
    expect(Object.keys(FINDING_PREDICATES).sort()).toEqual([...FINDING_CODES].sort());
    expect(Object.keys(CASES).sort()).toEqual([...FINDING_CODES].sort());
  });

  for (const code of FINDING_CODES) {
    it(`${code}: holds on its matching evidence`, () => {
      expect(FINDING_PREDICATES[code](CASES[code].matching)).toBe(true);
    });
  }

  for (const code of FINDING_CODES) {
    if (code === 'OTHER') continue; // OTHER is the deliberate always-true catch-all (see predicates.ts)
    it(`${code}: fails on its non-matching evidence`, () => {
      expect(FINDING_PREDICATES[code](CASES[code].nonMatching)).toBe(false);
    });
  }

  it('OTHER always holds, matching or not, since it has no fixed evidence shape', () => {
    expect(FINDING_PREDICATES.OTHER([])).toBe(true);
    expect(FINDING_PREDICATES.OTHER(CASES.WEBHOOK_HTTP_500.matching)).toBe(true);
  });
});
