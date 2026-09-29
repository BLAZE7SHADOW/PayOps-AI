import type { AgentRunItem } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { describeHandoff } from './handoff';

type Run = Pick<AgentRunItem, 'status' | 'diagnosis' | 'policy' | 'validation' | 'error'>;
const run = (o: Partial<Run>): Run => ({ status: 'ESCALATED', diagnosis: null, policy: null, validation: null, error: null, ...o });
const diagnosis = (rootCause: string, narrative: string) => ({ rootCause, narrative, confidence: 0.9, supportingFindingIds: [], path: 'FULL' }) as unknown as Run['diagnosis'];

describe('describeHandoff', () => {
  it('has nothing to say while a run is working or after it resolved the case', () => {
    expect(describeHandoff(run({ status: 'RESOLVED' }))).toBeNull();
    expect(describeHandoff(run({ status: 'INVESTIGATING' }))).toBeNull();
    expect(describeHandoff(run({ status: 'AWAITING_APPROVAL' }))).toBeNull();
  });

  it('explains an unconfirmed cause with the reason and the causes the evidence supported', () => {
    const h = describeHandoff(run({ diagnosis: diagnosis('UNKNOWN', 'The evidence does not point to one clear cause. The stated cause DUPLICATE_CAPTURE was not confirmed: Fewer than two captures. Causes the evidence supports: WEBHOOK_PROCESSING_FAILURE, SUSPECTED_FRAUD.') }));
    expect(h?.title).toBe('The agent could not confirm the cause.');
    expect(h?.reason).toContain('Causes the evidence supports: WEBHOOK_PROCESSING_FAILURE, SUSPECTED_FRAUD.');
    expect(h?.steps.join(' ')).toContain('Resolve manually');
  });

  it('explains a policy block with the rules that blocked it', () => {
    const h = describeHandoff(run({ policy: { tier: 'BLOCKED', reasons: [{ ruleId: 'P1', tier: 'BLOCKED', reason: 'Risk is CRITICAL.' }, { ruleId: 'P10', tier: 'AUTO', reason: 'Only holds.' }], version: 'v', moneyMovingMinor: 0, riskTier: 'CRITICAL' } }));
    expect(h?.title).toBe('Policy blocked the proposed fix.');
    expect(h?.reason).toBe('Risk is CRITICAL.');
  });

  it('explains a fix that ran but failed its checks, naming the failed check', () => {
    const check = (pass: boolean) => ({ id: 'c', subject: 'order.status', description: 'Order is paid', expected: 'PAID', actual: 'FAILED', pass, kind: 'POSTCONDITION', actionIndex: 0 });
    const h = describeHandoff(run({ validation: { verdict: 'FAIL', checks: [check(true), check(false)] as never } }));
    expect(h?.title).toBe('The fix ran but the check did not pass.');
    expect(h?.reason).toBe('Order is paid: expected PAID, found FAILED.');
  });

  it('says a person rejected the fix and that nothing changed', () => {
    const h = describeHandoff(run({ status: 'REJECTED' }));
    expect(h?.title).toBe('A person rejected the proposed fix.');
    expect(h?.reason).toContain('Nothing was changed');
  });

  it('reports the recorded error when the run stopped before proposing', () => {
    const h = describeHandoff(run({ error: 'Gemini call failed while diagnosing the case: timeout' }));
    expect(h?.title).toBe('The agent stopped before proposing a fix.');
    expect(h?.reason).toBe('Gemini call failed while diagnosing the case: timeout');
  });

  it('falls back to a plain message for a failed run with no detail', () => {
    const h = describeHandoff(run({ status: 'FAILED' }));
    expect(h?.title).toBe('The investigation did not finish.');
    expect(h?.steps.length).toBeGreaterThan(0);
  });
});
