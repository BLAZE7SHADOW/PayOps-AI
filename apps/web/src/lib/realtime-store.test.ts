import { beforeEach, describe, expect, it } from 'vitest';
import type { CaseListItem } from '@payops/shared';
import { useRealtimeStore } from './realtime-store';

const item = { id: 'case_1', displayId: 'PAY-0042', type: 'PAYMENT_MISMATCH', amountMinor: 100 } as CaseListItem;

beforeEach(() => useRealtimeStore.setState({ notices: [] }));

describe('realtime notices', () => {
  it('keeps at most three', () => {
    const { pushNotice } = useRealtimeStore.getState();
    for (let i = 0; i < 5; i++) pushNotice({ kind: 'local', text: `n${i}`, subject: `s${i}` });
    expect(useRealtimeStore.getState().notices.map((n) => n.subject)).toEqual(['s2', 's3', 's4']);
  });

  it('does not let a plain case update replace the verified line for the same case', () => {
    const { pushNotice } = useRealtimeStore.getState();
    pushNotice({ kind: 'verified', caseId: 'case_1', displayId: 'PAY-0042', verdict: 'PASS', subject: 'case:case_1' });
    pushNotice({ kind: 'updated', item, subject: 'case:case_1' });
    expect(useRealtimeStore.getState().notices).toHaveLength(1);
    expect(useRealtimeStore.getState().notices[0]?.kind).toBe('verified');
  });
});
