import { describe, expect, it } from 'vitest';
import type { CaseDetail } from '@payops/shared';
import { caseVerdict } from './case-verdict';

function make(over: Record<string, unknown>, resolutions: unknown[] = []) {
  return { status: 'OPEN', resolution: null, resolutionView: { resolutions }, ...over } as unknown as CaseDetail;
}

describe('caseVerdict', () => {
  it('says an automatic fix needs nothing from the operator', () => {
    const v = caseVerdict(make({ status: 'RESOLVED', resolution: { by: 'AGENT', summary: '' } }));
    expect(v.tone).toBe('ok');
    expect(v.text).toBe('Fixed automatically and verified. Nothing needed from you.');
  });
  it('names the approver when a person approved the fix', () => {
    const v = caseVerdict(make({ status: 'RESOLVED', resolution: { by: 'AGENT', summary: '' } }, [{ attempt: 1, approval: { decidedBy: { name: 'Asha' }, tier: 'OPS' } }]));
    expect(v.text).toContain('Asha');
  });
  it('credits a manual fix to a person', () => {
    expect(caseVerdict(make({ status: 'RESOLVED', resolution: { by: 'USER', summary: '' } })).text).toMatch(/by a person/);
  });
  it('asks the right role to approve, using the newest attempt', () => {
    const v = caseVerdict(make({ status: 'AWAITING_APPROVAL' }, [{ attempt: 1, approval: { tier: 'OPS' } }, { attempt: 2, approval: { tier: 'MANAGER' } }]));
    expect(v.tone).toBe('warn');
    expect(v.text).toContain('a manager');
  });
  it('flags escalation as needing a person', () => {
    expect(caseVerdict(make({ status: 'ESCALATED' })).tone).toBe('bad');
  });
  it('covers every other status', () => {
    for (const status of ['REJECTED', 'EXECUTING', 'INVESTIGATING', 'OPEN']) expect(caseVerdict(make({ status })).text.length).toBeGreaterThan(10);
  });
});
