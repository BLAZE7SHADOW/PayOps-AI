/**
 * Detection rules D1–D8 (docs/04-data-model.md › Detection rules). Each rule is a pure function
 * of an OrderSnapshot and returns at most one hit. D7 works on settlement batches and lives in
 * settlement.ts. Thresholds are named constants so tests and docs can point at them.
 */
import {
  AMOUNT_BAND_THRESHOLDS_MINOR,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  formatMoney,
  type CaseType,
  type DetectionRuleId,
  type Severity,
} from '@payops/shared';
import {
  PAID_ORDER_STATUSES,
  captureCreditMinor,
  capturedGw,
  capturedTotalMinor,
  gatewayRefundedMinor,
  isCaptured,
  lastTransitionAt,
  msSince,
  outstandingCapturedMinor,
} from './facts';
import type { OrderSnapshot } from './snapshot';

export const RULE_THRESHOLDS = {
  /** Grace period before a capture without an order/ledger update is an exception. */
  captureGraceMs: 10 * MINUTE_MS,
  refundSlaMs: 7 * DAY_MS,
  cancelledRefundGraceMs: 48 * HOUR_MS,
  riskWindowMs: 24 * HOUR_MS,
  riskMinFailedAttempts: 5,
  riskMinCaptureMinor: AMOUNT_BAND_THRESHOLDS_MINOR.HIGH, // ₹10,000
} as const;

export type EntityKind = 'payment' | 'order' | 'batch';

export interface RuleHit {
  ruleId: DetectionRuleId;
  caseType: CaseType;
  /** Minimum severity regardless of amount. */
  severityFloor?: Severity;
  primaryEntity: { kind: EntityKind; id: string };
  amountMinor: number;
  /** One plain sentence explaining why the rule fired. */
  reason: string;
}

export type OrderRule = (s: OrderSnapshot) => RuleHit | null;

/** Cases about a payment key on our internal payment id, or the gateway id if we never created one. */
function paymentEntity(s: OrderSnapshot): { kind: EntityKind; id: string } {
  const id = s.payment?.id ?? s.primaryGw?.id;
  return id ? { kind: 'payment', id } : { kind: 'order', id: s.order.id };
}

/** First captured gateway payment still holding money, preferring the primary one. */
function heldCapture(s: OrderSnapshot) {
  const held = capturedGw(s).filter((g) => g.amountMinor > g.refundedMinor);
  return held.find((g) => g.id === s.primaryGw?.id) ?? held[0] ?? null;
}

export const d1CapturedNotPaid: OrderRule = (s) => {
  const gw = heldCapture(s);
  if (!gw || outstandingCapturedMinor(s) === 0) return null;
  if (PAID_ORDER_STATUSES.has(s.order.status) || s.order.status === 'CANCELLED') return null;
  if (msSince(s.now, gw.capturedAt) <= RULE_THRESHOLDS.captureGraceMs) return null;
  return {
    ruleId: 'D1_CAPTURED_NOT_PAID',
    caseType: 'PAYMENT_MISMATCH',
    primaryEntity: paymentEntity(s),
    amountMinor: gw.amountMinor,
    reason: `Gateway captured ${formatMoney(gw.amountMinor)} but the order is ${s.order.status}.`,
  };
};

export const d2PaidNotCaptured: OrderRule = (s) => {
  if (!PAID_ORDER_STATUSES.has(s.order.status) || capturedGw(s).length > 0) return null;
  return {
    ruleId: 'D2_PAID_NOT_CAPTURED',
    caseType: 'PAYMENT_MISMATCH',
    severityFloor: 'HIGH',
    primaryEntity: paymentEntity(s),
    amountMinor: s.order.amountMinor,
    reason: `Order is ${s.order.status} but the gateway shows ${s.primaryGw?.status ?? 'no payment'}.`,
  };
};

export const d3LedgerMissing: OrderRule = (s) => {
  const gw = s.primaryGw;
  if (!gw || !isCaptured(gw)) return null;
  const credit = captureCreditMinor(s);
  if (credit >= gw.amountMinor) return null;
  if (msSince(s.now, gw.capturedAt) <= RULE_THRESHOLDS.captureGraceMs) return null;
  const missing = gw.amountMinor - credit;
  return {
    ruleId: 'D3_LEDGER_MISSING',
    caseType: 'PAYMENT_MISMATCH',
    severityFloor: 'MEDIUM',
    primaryEntity: paymentEntity(s),
    amountMinor: missing,
    reason: `Ledger capture credit is ${formatMoney(credit)} for a ${formatMoney(gw.amountMinor)} capture.`,
  };
};

export const d4DuplicateCapture: OrderRule = (s) => {
  const captured = capturedGw(s);
  if (captured.length <= 1) return null;
  const keep = captured.find((g) => g.id === s.primaryGw?.id) ?? captured[0];
  const extra = capturedTotalMinor(s) - (keep?.amountMinor ?? 0);
  return {
    ruleId: 'D4_DUPLICATE_CAPTURE',
    caseType: 'DUPLICATE',
    severityFloor: 'HIGH',
    primaryEntity: { kind: 'order', id: s.order.id },
    amountMinor: extra,
    reason: `${captured.length} captures recorded for one order; ${formatMoney(extra)} captured more than once.`,
  };
};

export const d5RefundPendingSla: OrderRule = (s) => {
  const stale = s.refunds
    .filter((r) => (r.status === 'REQUESTED' || r.status === 'PENDING') && msSince(s.now, r.requestedAt) > RULE_THRESHOLDS.refundSlaMs)
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const oldest = stale[0];
  if (!oldest) return null;
  const days = Math.floor(msSince(s.now, oldest.requestedAt) / DAY_MS);
  return {
    ruleId: 'D5_REFUND_PENDING_SLA',
    caseType: 'REFUND_EXCEPTION',
    severityFloor: 'MEDIUM',
    primaryEntity: paymentEntity(s),
    amountMinor: oldest.amountMinor,
    reason: `Refund of ${formatMoney(oldest.amountMinor)} has been ${oldest.status} for ${days} days.`,
  };
};

export const d6RefundMissing: OrderRule = (s) => {
  if (s.order.status !== 'CANCELLED') return null;
  const cancelledAt = lastTransitionAt(s.order, 'CANCELLED');
  if (!cancelledAt || msSince(s.now, cancelledAt) <= RULE_THRESHOLDS.cancelledRefundGraceMs) return null;
  const captured = capturedTotalMinor(s);
  if (captured === 0 || s.refunds.length > 0) return null;
  const refunded = gatewayRefundedMinor(s);
  if (refunded >= captured) return null;
  const owed = captured - refunded;
  return {
    ruleId: 'D6_REFUND_MISSING',
    caseType: 'REFUND_EXCEPTION',
    primaryEntity: paymentEntity(s),
    amountMinor: owed,
    reason: `Order was cancelled but ${formatMoney(owed)} captured has no refund.`,
  };
};

export const d8RiskVelocity: OrderRule = (s) => {
  const gw = s.primaryGw;
  if (!gw || !isCaptured(gw) || gw.amountMinor < RULE_THRESHOLDS.riskMinCaptureMinor) return null;
  const end = (gw.capturedAt ?? s.now).getTime();
  const start = end - RULE_THRESHOLDS.riskWindowMs;
  const failed = s.recentAttempts.filter(
    (a) => a.result === 'FAILED' && a.at.getTime() >= start && a.at.getTime() < end,
  );
  if (failed.length < RULE_THRESHOLDS.riskMinFailedAttempts) return null;
  const countries = new Set(failed.map((a) => a.cardCountry).filter((c): c is string => c !== null));
  return {
    ruleId: 'D8_RISK_VELOCITY',
    caseType: 'RISK_CASE',
    severityFloor: 'HIGH',
    primaryEntity: paymentEntity(s),
    amountMinor: gw.amountMinor,
    reason: `${failed.length} failed attempts across ${countries.size} card countries in 24h before a ${formatMoney(gw.amountMinor)} capture.`,
  };
};

export const ORDER_RULES: readonly OrderRule[] = [
  d1CapturedNotPaid,
  d2PaidNotCaptured,
  d3LedgerMissing,
  d4DuplicateCapture,
  d5RefundPendingSla,
  d6RefundMissing,
  d8RiskVelocity,
];

export function runOrderRules(s: OrderSnapshot): RuleHit[] {
  return ORDER_RULES.map((rule) => rule(s)).filter((h): h is RuleHit => h !== null);
}
