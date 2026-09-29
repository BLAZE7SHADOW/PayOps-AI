import { describe, expect, it } from 'vitest';
import type { CaseDetail } from '@payops/shared';
import { caseDetail, resolution } from './case-story.fixtures';
import { undoableResolution } from './undo';

const posted = (over: Parameters<typeof resolution>[0] = {}) =>
  resolution({
    actions: [{ type: 'POST_LEDGER_ENTRY', params: { paymentId: 'pay_1', amountMinor: 499900 } }],
    executions: [{ index: 0, type: 'POST_LEDGER_ENTRY', status: 'SUCCEEDED', idempotencyKey: 'k', summary: 'Posted', error: null, before: null, startedAt: '', finishedAt: '' }],
    ...over,
  });
const caseWith = (status: string, ...resolutions: ReturnType<typeof resolution>[]) =>
  ({ ...caseDetail, status, resolutionView: { resolutions } }) as unknown as CaseDetail;

describe('undoableResolution', () => {
  it('offers the latest passed resolution that posted to the ledger on a resolved case', () => {
    expect(undoableResolution(caseWith('RESOLVED', posted()))?.id).toBe('res_1');
  });
  it('offers nothing for other actions, open cases, failed validation, or an earlier attempt', () => {
    expect(undoableResolution(caseWith('RESOLVED', resolution()))).toBeNull();
    expect(undoableResolution(caseWith('OPEN', posted()))).toBeNull();
    expect(undoableResolution(caseWith('RESOLVED', posted({ validation: null })))).toBeNull();
    expect(undoableResolution(caseWith('RESOLVED', posted({ id: 'res_a', attempt: 1 }), resolution({ id: 'res_b', attempt: 2 })))).toBeNull();
  });
  it('does not offer to undo an undo', () => {
    const undo = posted({ actions: [{ type: 'REVERSE_LEDGER_ENTRY', params: { journalId: 'jrn_1', undoOf: 'res_0' } }],
      executions: [{ index: 0, type: 'REVERSE_LEDGER_ENTRY', status: 'SUCCEEDED', idempotencyKey: 'k', summary: 'Reversed', error: null, before: null, startedAt: '', finishedAt: '' }] });
    expect(undoableResolution(caseWith('RESOLVED', undo))).toBeNull();
  });
});
