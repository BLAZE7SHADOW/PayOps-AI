/**
 * Root-cause confirmation checks (P1 task 1, closes the D057 gap).
 *
 * The validator only proves the data was fixed afterwards. It cannot tell whether the stated
 * root cause was right, so a refund that was "resolved" could still carry the wrong label. These
 * checks run in code over the whole evidence pool and confirm that the facts actually support the
 * stated cause. When a check fails, `resolve` downgrades the diagnosis to UNKNOWN, which proposes
 * an escalation to a person instead of an automatic fix under a wrong label.
 *
 * Unlike the FindingCode predicates (predicates.ts), which only ask "did this finding cite the
 * right kind of evidence", these read the fact values and can reject a plausible but wrong cause
 * (for example a 500 response labelled as "never delivered"). They only use facts that tools.ts
 * already projects. SETTLEMENT_LINE_MISSING is as loose as SETTLEMENT_FEE_MISMATCH because no
 * tool projects "this specific line is absent" (D041).
 */
import type { EvidenceItem, RootCause } from '@payops/shared';

export type RootCauseCheck = { ok: true } | { ok: false; reason: string };

const OK: RootCauseCheck = { ok: true };
const fail = (reason: string): RootCauseCheck => ({ ok: false, reason });

const from = (ev: readonly EvidenceItem[], source: string) => ev.filter((e) => e.source === source);
const num = (e: EvidenceItem, key: string): number => (typeof e.facts[key] === 'number' ? (e.facts[key] as number) : 0);
const str = (e: EvidenceItem, key: string): string | null => (typeof e.facts[key] === 'string' ? (e.facts[key] as string) : null);

const capturedGateway = (ev: readonly EvidenceItem[]) => from(ev, 'getGatewayPayment').filter((e) => str(e, 'status') === 'CAPTURED');

export const ROOT_CAUSE_CHECKS: Record<RootCause, (ev: readonly EvidenceItem[]) => RootCauseCheck> = {
  WEBHOOK_PROCESSING_FAILURE: (ev) =>
    from(ev, 'getWebhookDeliveries').some((e) => num(e, 'lastHttpStatus') >= 400)
      ? OK
      : fail('No webhook delivery shows an error response from our consumer.'),

  // A non-2xx response means the webhook arrived and processing failed, so it is not "never delivered".
  WEBHOOK_NOT_DELIVERED: (ev) =>
    from(ev, 'getWebhookDeliveries').some((e) => str(e, 'finalStatus') !== 'DELIVERED' && num(e, 'lastHttpStatus') < 400)
      ? OK
      : fail('No undelivered webhook without an error response was found; a consumer error would be a processing failure.'),

  ORDER_STATE_DIVERGED: (ev) => {
    if (capturedGateway(ev).length === 0) return fail('The gateway does not show a captured payment to compare against.');
    const orderBehind = from(ev, 'getOrder').some((e) => ['PENDING', 'FAILED'].includes(str(e, 'status') ?? ''));
    const paymentBehind = from(ev, 'getInternalPayment').some((e) => str(e, 'status') !== 'CAPTURED');
    return orderBehind || paymentBehind ? OK : fail('Our order and payment records already match the captured gateway payment.');
  },

  LEDGER_POSTING_MISSING: (ev) => {
    if (capturedGateway(ev).length === 0) return fail('There is no captured gateway payment that should have a ledger credit.');
    return ev.some((e) => e.system === 'LEDGER' && str(e, 'direction') === 'CREDIT') ? fail('A ledger credit exists for this payment.') : OK;
  },

  DUPLICATE_CAPTURE: (ev) =>
    new Set(capturedGateway(ev).map((e) => e.entityRef)).size >= 2 ? OK : fail('Fewer than two distinct captured gateway payments were found.'),

  REFUND_STATUS_NOT_SYNCED: (ev) => {
    const internal = from(ev, 'getRefund')[0];
    const gateway = from(ev, 'getRefundGatewayStatus')[0];
    if (!internal || !gateway) return fail('Both our refund record and the gateway refund status are needed to show a sync gap.');
    if (str(gateway, 'status') === 'FAILED') return fail('The gateway refund failed; that is a gateway failure, not a sync gap.');
    return str(internal, 'status') !== str(gateway, 'status') ? OK : fail('Our refund status already matches the gateway.');
  },

  REFUND_NOT_INITIATED: (ev) => {
    if (capturedGateway(ev).length === 0) return fail('There is no captured payment that would need a refund.');
    if (!from(ev, 'getOrder').some((e) => str(e, 'status') === 'CANCELLED')) return fail('The order is not cancelled.');
    return from(ev, 'getRefund').length === 0 ? OK : fail('A refund record already exists.');
  },

  // The gateway side must report FAILED. Our record alone saying FAILED while the gateway says
  // otherwise is a sync problem.
  REFUND_FAILED_AT_GATEWAY: (ev) =>
    from(ev, 'getRefundGatewayStatus').some((e) => str(e, 'status') === 'FAILED') ? OK : fail('The gateway does not report the refund as failed.'),

  SETTLEMENT_FEE_MISMATCH: (ev) => settlementDiffers(ev),
  SETTLEMENT_LINE_MISSING: (ev) => settlementDiffers(ev),

  SUSPECTED_FRAUD: (ev) => {
    const signals = ev.filter((e) => e.system === 'RISK');
    const strong =
      signals.some((e) => num(e, 'failed24h') >= 3) ||
      signals.some((e) => num(e, 'cardCountriesDistinct') >= 3) ||
      signals.some((e) => e.facts.ipCardCountryMismatch === true) ||
      signals.some((e) => num(e, 'riskFlagsCount') > 0);
    return strong ? OK : fail('No risk signal is strong enough to support suspected fraud.');
  },

  UNKNOWN: () => OK,
};

function settlementDiffers(ev: readonly EvidenceItem[]): RootCauseCheck {
  return from(ev, 'getFeeBreakdown').some((e) => num(e, 'diffMinor') !== 0) ? OK : fail('The settlement batch net matches what the ledger expects.');
}

export function checkRootCause(rootCause: RootCause, evidence: readonly EvidenceItem[]): RootCauseCheck {
  return ROOT_CAUSE_CHECKS[rootCause](evidence);
}
