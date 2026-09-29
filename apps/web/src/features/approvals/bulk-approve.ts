import { bulkApproveBlockReason, type ApprovalItem } from '@payops/shared';

/**
 * Pending approvals this person could approve in bulk. The server repeats these checks, and
 * also skips cases with quarantined notes, which the list does not carry.
 */
export function bulkEligible(items: readonly ApprovalItem[]): ApprovalItem[] {
  return items.filter(
    (a) =>
      a.status === 'PENDING' &&
      a.canDecide &&
      bulkApproveBlockReason({
        tier: a.tier,
        riskTier: a.riskTier,
        moneyMovingMinor: a.moneyMovingMinor,
        ruleIds: a.ruleIds,
        actionTypes: a.actionTypes,
        quarantined: false,
      }) === null,
  );
}
