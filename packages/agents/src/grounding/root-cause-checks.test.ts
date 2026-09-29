/**
 * Root-cause confirmation checks (P1 task 1, closes the D057 gap): the validator only proves the
 * data is fixed, so a wrong root-cause label could still pass. Each RootCause here has one case
 * where the evidence confirms it and at least one where a plausible-but-wrong label must be
 * rejected.
 */
import { describe, expect, it } from 'vitest';
import { ROOT_CAUSES, type EvidenceItem, type RootCause } from '@payops/shared';
import { checkRootCause, ROOT_CAUSE_CHECKS } from './root-cause-checks';

let n = 0;
function ev(source: string, system: EvidenceItem['system'], facts: EvidenceItem['facts'], entityRef?: string): EvidenceItem {
  n += 1;
  return { id: `ev_${n}`, source, system, entityRef: entityRef ?? `ent_${n}`, facts, observedAt: '2026-01-01T00:00:00Z', stepId: 'test' };
}
const gw = (status: string, ref?: string) => ev('getGatewayPayment', 'GATEWAY', { status }, ref);
const order = (status: string) => ev('getOrder', 'ORDER', { status });
const webhook = (finalStatus: string, lastHttpStatus: number) => ev('getWebhookDeliveries', 'WEBHOOK', { finalStatus, lastHttpStatus, attempts: 3 });
const refund = (status: string) => ev('getRefund', 'REFUND', { status });
const gwRefund = (status: string) => ev('getRefundGatewayStatus', 'REFUND', { status });
const fee = (diffMinor: number) => ev('getFeeBreakdown', 'SETTLEMENT', { diffMinor, matched: diffMinor === 0 });

const CASES: Record<Exclude<RootCause, 'UNKNOWN'>, { confirmed: EvidenceItem[]; rejected: EvidenceItem[] }> = {
  WEBHOOK_PROCESSING_FAILURE: {
    confirmed: [webhook('FAILED', 500)],
    rejected: [webhook('DELIVERED', 200)],
  },
  WEBHOOK_NOT_DELIVERED: {
    confirmed: [webhook('PENDING', 0)],
    // The consumer answered 500, so this is a processing failure, not a missed delivery.
    rejected: [webhook('FAILED', 500)],
  },
  ORDER_STATE_DIVERGED: {
    confirmed: [gw('CAPTURED'), order('PENDING')],
    rejected: [gw('CAPTURED'), order('PAID')],
  },
  LEDGER_POSTING_MISSING: {
    confirmed: [gw('CAPTURED'), order('PAID')],
    rejected: [gw('CAPTURED'), ev('getLedgerEntries', 'LEDGER', { direction: 'CREDIT', account: 'X' })],
  },
  DUPLICATE_CAPTURE: {
    confirmed: [gw('CAPTURED', 'gw_1'), gw('CAPTURED', 'gw_2')],
    rejected: [gw('CAPTURED', 'gw_1'), gw('FAILED', 'gw_2')],
  },
  REFUND_STATUS_NOT_SYNCED: {
    confirmed: [refund('PENDING'), gwRefund('PROCESSED')],
    rejected: [refund('PROCESSED'), gwRefund('PROCESSED')],
  },
  REFUND_NOT_INITIATED: {
    confirmed: [gw('CAPTURED'), order('CANCELLED')],
    rejected: [gw('CAPTURED'), order('CANCELLED'), refund('PENDING')],
  },
  REFUND_FAILED_AT_GATEWAY: {
    confirmed: [refund('PENDING'), gwRefund('FAILED')],
    // Our record says FAILED but the gateway says PROCESSED: that is a sync gap, not a gateway failure.
    rejected: [refund('FAILED'), gwRefund('PROCESSED')],
  },
  SETTLEMENT_FEE_MISMATCH: {
    confirmed: [fee(-500)],
    rejected: [fee(0)],
  },
  SETTLEMENT_LINE_MISSING: {
    confirmed: [fee(-500)],
    rejected: [fee(0)],
  },
  SUSPECTED_FRAUD: {
    confirmed: [ev('getFailedAttempts', 'RISK', { failed24h: 8, total24h: 9 })],
    rejected: [ev('getFailedAttempts', 'RISK', { failed24h: 0, total24h: 1 }), ev('getDeviceSignals', 'RISK', { cardCountriesDistinct: 1, ipCardCountryMismatch: false })],
  },
};

describe('root cause checks', () => {
  it('has a check for every root cause', () => {
    expect(Object.keys(ROOT_CAUSE_CHECKS).sort()).toEqual([...ROOT_CAUSES].sort());
  });

  for (const [cause, { confirmed, rejected }] of Object.entries(CASES) as [RootCause, (typeof CASES)[keyof typeof CASES]][]) {
    it(`${cause}: confirmed by matching evidence`, () => {
      expect(checkRootCause(cause, confirmed)).toEqual({ ok: true });
    });
    it(`${cause}: a wrong label is rejected with a reason`, () => {
      const result = checkRootCause(cause, rejected);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
    });
  }

  it('UNKNOWN never needs confirming', () => {
    expect(checkRootCause('UNKNOWN', [])).toEqual({ ok: true });
  });

  it('empty evidence confirms nothing', () => {
    for (const cause of ROOT_CAUSES) {
      if (cause !== 'UNKNOWN') expect(checkRootCause(cause, []).ok).toBe(false);
    }
  });
});
