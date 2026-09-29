import { describe, expect, it } from 'vitest';
import { BULK_APPROVE_MAX_MINOR, BulkApprovalBody, bulkApproveBlockReason, type BulkApproveInput } from './bulk-approve';

const ok: BulkApproveInput = {
  tier: 'OPS',
  riskTier: 'LOW',
  moneyMovingMinor: 2_000_00,
  ruleIds: ['P4'],
  actionTypes: ['INITIATE_REFUND'],
  quarantined: false,
};

describe('bulkApproveBlockReason', () => {
  it('allows an OPS-tier, low-risk proposal under the limit', () => {
    expect(bulkApproveBlockReason(ok)).toBeNull();
    expect(bulkApproveBlockReason({ ...ok, moneyMovingMinor: BULK_APPROVE_MAX_MINOR })).toBeNull();
  });

  it('blocks every other tier', () => {
    expect(bulkApproveBlockReason({ ...ok, tier: 'MANAGER' })).toMatch(/OPS tier/);
    expect(bulkApproveBlockReason({ ...ok, tier: 'BLOCKED' })).toMatch(/OPS tier/);
    expect(bulkApproveBlockReason({ ...ok, tier: 'AUTO' })).toMatch(/OPS tier/);
  });

  it('blocks risk above LOW, amounts above the limit and quarantined notes', () => {
    expect(bulkApproveBlockReason({ ...ok, riskTier: 'MEDIUM' })).toMatch(/risk/i);
    expect(bulkApproveBlockReason({ ...ok, moneyMovingMinor: BULK_APPROVE_MAX_MINOR + 1 })).toMatch(/limit/);
    expect(bulkApproveBlockReason({ ...ok, quarantined: true })).toMatch(/quarantined/i);
  });

  it('blocks repeat attempts and low-confidence diagnoses', () => {
    expect(bulkApproveBlockReason({ ...ok, ruleIds: ['P4', 'P7'] })).toMatch(/second attempt|repeat/i);
    expect(bulkApproveBlockReason({ ...ok, ruleIds: ['P8'] })).toMatch(/confidence/i);
  });
});

describe('BulkApprovalBody', () => {
  it('needs 1 to 25 ids and defaults the comment', () => {
    expect(BulkApprovalBody.parse({ ids: ['apr_1'] }).comment).toBe('');
    expect(BulkApprovalBody.safeParse({ ids: [] }).success).toBe(false);
    expect(BulkApprovalBody.safeParse({ ids: Array.from({ length: 26 }, (_, i) => `apr_${i}`) }).success).toBe(false);
  });
});
