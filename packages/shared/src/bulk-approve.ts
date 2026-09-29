/**
 * Bulk approve (P2 task 3, D069). One rule decides which pending approvals may be approved in a
 * batch, so the server and the Exceptions page agree. Bulk approve is only a shortcut for
 * clicking Approve on each item: every item still goes through the normal decision path
 * (role, four-eyes, executor, validator). Anything that needs a closer look is left out.
 */
import { z } from 'zod';
import type { PolicyTier, RiskTier } from './policy';

/** Money-moving amount at or below which an OPS-tier proposal may be bulk approved (INR 5,000, in paise). */
export const BULK_APPROVE_MAX_MINOR = 5_000_00;
export const BULK_APPROVE_MAX_ITEMS = 25;

export interface BulkApproveInput {
  tier: PolicyTier;
  riskTier: RiskTier;
  moneyMovingMinor: number;
  ruleIds: readonly string[];
  actionTypes: readonly string[];
  /** The case's customer or merchant notes were quarantined by J1 screening. */
  quarantined: boolean;
}

/** Why this approval cannot be part of a bulk approve, or null when it can. */
export function bulkApproveBlockReason(a: BulkApproveInput): string | null {
  if (a.tier !== 'OPS') return 'Only OPS tier approvals can be approved in bulk.';
  if (a.riskTier !== 'LOW') return `Risk is ${a.riskTier.toLowerCase()}, not low. Open the case.`;
  if (a.quarantined) return 'The case has quarantined notes. Open the case.';
  if (a.moneyMovingMinor > BULK_APPROVE_MAX_MINOR) return 'Amount is over the bulk approve limit. Open the case.';
  if (a.ruleIds.includes('P7')) return 'This is a repeat attempt. Open the case.';
  if (a.ruleIds.includes('P8')) return 'The diagnosis has low confidence. Open the case.';
  return null;
}

export const BulkApprovalBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(BULK_APPROVE_MAX_ITEMS),
  comment: z.string().trim().max(1000).default(''),
});
export type BulkApprovalBody = z.infer<typeof BulkApprovalBody>;

export interface BulkApprovalResultItem {
  approvalId: string;
  displayId: string | null;
  outcome: 'APPROVED' | 'SKIPPED' | 'FAILED';
  message: string;
}
export interface BulkApprovalResult {
  approved: number;
  skipped: number;
  failed: number;
  items: BulkApprovalResultItem[];
}
