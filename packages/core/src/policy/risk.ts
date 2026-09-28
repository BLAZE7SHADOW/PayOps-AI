/**
 * Rules-only risk tier. Used for every proposal in Phase 2 and later as the deterministic
 * fallback when Jev J3 is unavailable. It never returns CRITICAL: that needs more than rules.
 */
import { AMOUNT_BAND_THRESHOLDS_MINOR, type RiskTier } from '@payops/shared';
import { isCaptured } from '../reconciliation/facts';
import { RULE_THRESHOLDS } from '../reconciliation/rules';
import type { OrderSnapshot } from '../reconciliation/snapshot';

export const RISK_RULES = {
  highMinFailedAttempts: 5,
  highMinCaptureMinor: AMOUNT_BAND_THRESHOLDS_MINOR.HIGH, // ₹10,000
  mediumMinFailedAttempts: 3,
} as const;

/** Failed attempts by the customer in the 24 hours before the capture (or before now). */
export function failedAttemptsBeforeCapture(s: Pick<OrderSnapshot, 'primaryGw' | 'recentAttempts' | 'now'>): number {
  const end = (s.primaryGw?.capturedAt ?? s.now).getTime();
  const start = end - RULE_THRESHOLDS.riskWindowMs;
  return s.recentAttempts.filter((a) => a.result === 'FAILED' && a.at.getTime() >= start && a.at.getTime() < end).length;
}

export function riskTierFromRules(s: Pick<OrderSnapshot, 'primaryGw' | 'recentAttempts' | 'now'> | null): RiskTier {
  if (!s) return 'LOW';
  const failed = failedAttemptsBeforeCapture(s);
  const captured = isCaptured(s.primaryGw) ? (s.primaryGw?.amountMinor ?? 0) : 0;
  if (failed >= RISK_RULES.highMinFailedAttempts && captured >= RISK_RULES.highMinCaptureMinor) return 'HIGH';
  if (failed >= RISK_RULES.mediumMinFailedAttempts) return 'MEDIUM';
  return 'LOW';
}
