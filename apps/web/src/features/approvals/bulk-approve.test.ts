import type { ApprovalItem } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { bulkEligible } from './bulk-approve';

const item = (o: Partial<ApprovalItem> = {}): ApprovalItem =>
  ({
    id: 'apr_1',
    case: { id: 'cas_1', displayId: 'PAY-0001', type: 'DUPLICATE', status: 'AWAITING_APPROVAL', amountMinor: 200_000 },
    resolutionId: 'res_1',
    tier: 'OPS',
    status: 'PENDING',
    actionsSummary: 'Refund duplicate',
    actionTypes: ['INITIATE_REFUND'],
    moneyMovingMinor: 200_000,
    riskTier: 'LOW',
    ruleIds: ['P4'],
    requestedBy: { type: 'USER', id: 'usr_1', name: 'Ananya' },
    requestedAt: '2026-09-28T12:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    comment: null,
    canDecide: true,
    cannotDecideReason: null,
    ...o,
  }) as ApprovalItem;

describe('bulkEligible', () => {
  it('keeps low-risk OPS items the viewer can decide and drops the rest', () => {
    const keep = item({ id: 'a' });
    const rest = [
      item({ id: 'b', tier: 'MANAGER' }),
      item({ id: 'c', canDecide: false, cannotDecideReason: 'You proposed this resolution. Another person must approve it.' }),
      item({ id: 'd', riskTier: 'HIGH' }),
      item({ id: 'e', moneyMovingMinor: 9_000_00 }),
      item({ id: 'f', ruleIds: ['P4', 'P7'] }),
      item({ id: 'g', status: 'APPROVED' }),
    ];
    expect(bulkEligible([keep, ...rest]).map((a) => a.id)).toEqual(['a']);
  });
});
