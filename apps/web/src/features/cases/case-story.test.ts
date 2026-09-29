import type { CaseDetail } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { buildCaseStory, type StoryEntry } from './case-story';
import { at, caseDetail, records, resolution, run, steps } from './case-story.fixtures';

const byKind = (entries: StoryEntry[], kind: StoryEntry['kind']) => entries.filter((e) => e.kind === kind);

describe('buildCaseStory', () => {
  const c = { ...caseDetail, resolutionView: { resolutions: [resolution()] } } as unknown as CaseDetail;
  const story = buildCaseStory({ c, run: run(), steps, records });

  it('starts with the detection and ends with the outcome, numbered in order', () => {
    expect(story[0]!.kind).toBe('detected');
    expect(story.at(-1)!.kind).toBe('outcome');
    expect(story.map((e) => e.number)).toEqual(story.map((_, i) => i + 1));
  });

  it('labels the actor from what each step recorded, not from the step name', () => {
    const plan = story.find((e) => e.kind === 'step' && e.node === 'plan')!;
    expect(plan.actors).toEqual(['JEV']);
    expect(plan.jev).toEqual(['J2 plan']);
    const payment = story.find((e) => e.kind === 'step' && e.node === 'paymentAgent')!;
    expect(payment.actors).toEqual(['GEMINI']);
    const triage = story.find((e) => e.kind === 'step' && e.node === 'triage')!;
    expect(triage.actors).toEqual(['CODE']);
  });

  it('lists the records a step read with human labels, using the recorded evidence ids', () => {
    const triage = story.find((e) => e.kind === 'step' && e.node === 'triage');
    if (triage?.kind !== 'step') throw new Error('triage missing');
    expect(triage.facts.map((f) => f.evidenceId)).toEqual(['ev_01', 'ev_02']);
    expect(triage.facts[0]!.label).toBe('Gateway · gw_pay_1');
    expect(triage.facts[0]!.summary).toContain('₹4,999.00');
  });

  it('marks findings as supported or unsupported by the grounding result and keeps retries under their step', () => {
    const payment = story.find((e) => e.kind === 'step' && e.node === 'paymentAgent');
    if (payment?.kind !== 'step') throw new Error('payment missing');
    expect(payment.findings.map((f) => [f.id, f.grounding])).toEqual([['fd_01', 'SUPPORTED'], ['fd_02', 'UNSUPPORTED']]);
    expect(payment.findings[1]!.reason).toBe('Evidence does not mention this.');
    expect(payment.retries).toHaveLength(1);
    expect(payment.retries[0]).toContain('gemini');
  });

  it('shows what changed by comparing the recorded before-state with the current records', () => {
    const execution = byKind(story, 'execution')[0];
    if (execution?.kind !== 'execution') throw new Error('execution missing');
    const changes = execution.steps[0]!.changes;
    expect(changes).toEqual([
      expect.objectContaining({ recordId: 'ord_1', before: 'FAILED', after: 'PAID', isNew: false }),
      expect.objectContaining({ recordId: 'led_1', isNew: true }),
    ]);
  });

  it('reports an automatic approval for the AUTO tier', () => {
    const decision = byKind(story, 'decision')[0];
    if (decision?.kind !== 'decision') throw new Error('decision missing');
    expect(decision.approval).toEqual({ status: 'AUTOMATIC' });
  });

  it('uses the verifier checks as the expected versus actual table', () => {
    const verification = byKind(story, 'verification')[0];
    if (verification?.kind !== 'verification') throw new Error('verification missing');
    expect(verification.verdict).toBe('PASS');
    expect(verification.checks[0]).toMatchObject({ expected: 'PAID', actual: 'PAID', pass: true });
  });
});

describe('approval and progress states', () => {
  const waiting = { ...caseDetail, status: 'AWAITING_APPROVAL', resolutionView: { resolutions: [resolution({
    status: 'AWAITING_APPROVAL', executions: [], validation: null,
    policy: { tier: 'OPS', reasons: [{ ruleId: 'P2', tier: 'OPS', reason: 'Above the automatic limit' }], version: '1', moneyMovingMinor: 0, riskTier: 'LOW' },
    approval: { id: 'apr_1', tier: 'OPS', status: 'PENDING', decidedBy: null, comment: null, decidedAt: null },
  })] } } as unknown as CaseDetail;

  it('says who the case is waiting on and does not show execution as done', () => {
    const story = buildCaseStory({ c: waiting, run: run({ status: 'AWAITING_APPROVAL' }), steps, records });
    const decision = story.find((e) => e.kind === 'decision');
    if (decision?.kind !== 'decision') throw new Error('decision missing');
    expect(decision.approval).toEqual({ status: 'WAITING', role: 'OPS' });
    expect(story.some((e) => e.kind === 'execution')).toBe(false);
    expect(story.some((e) => e.kind === 'notStarted')).toBe(true);
    expect(story.at(-1)!.summary).toMatch(/waiting/i);
  });

  it('reports blocked and approved decisions', () => {
    const blocked = { ...waiting, resolutionView: { resolutions: [resolution({ status: 'BLOCKED', executions: [], validation: null, approval: null,
      policy: { tier: 'BLOCKED', reasons: [{ ruleId: 'P9', tier: 'BLOCKED', reason: 'Refund exceeds the payment' }], version: '1', moneyMovingMinor: 0, riskTier: 'LOW' } })] } } as unknown as CaseDetail;
    const decision = buildCaseStory({ c: blocked, run: undefined, steps: [], records }).find((e) => e.kind === 'decision');
    if (decision?.kind !== 'decision') throw new Error('decision missing');
    expect(decision.approval).toEqual({ status: 'BLOCKED' });

    const approved = { ...waiting, resolutionView: { resolutions: [resolution({ approval: { id: 'apr_1', tier: 'OPS', status: 'APPROVED', decidedBy: { type: 'USER', id: 'u2', name: 'Rahul Menon' }, comment: null, decidedAt: at },
      policy: { tier: 'OPS', reasons: [], version: '1', moneyMovingMinor: 0, riskTier: 'LOW' } })] } } as unknown as CaseDetail;
    const d2 = buildCaseStory({ c: approved, run: undefined, steps: [], records }).find((e) => e.kind === 'decision');
    if (d2?.kind !== 'decision') throw new Error('decision missing');
    expect(d2.approval).toEqual({ status: 'APPROVED', by: 'Rahul Menon', at });
    expect(d2.actors).toEqual(['PERSON', 'CODE']);
  });

  it('appends a running placeholder while an investigation is active', () => {
    const open = { ...caseDetail, status: 'INVESTIGATING', resolutionView: { resolutions: [] } } as unknown as CaseDetail;
    const story = buildCaseStory({ c: open, run: run({ status: 'INVESTIGATING', resolutionId: null, proposal: null, findings: [], grounding: null }), steps: steps.slice(0, 3), records });
    expect(story.at(-1)!.kind).toBe('running');
    expect(story.some((e) => e.kind === 'outcome')).toBe(false);
  });

  it('works with no run at all, starting from the detection', () => {
    const story = buildCaseStory({ c: { ...caseDetail, status: 'OPEN', resolutionView: { resolutions: [] } } as unknown as CaseDetail, run: undefined, steps: [], records });
    expect(story.map((e) => e.kind)).toEqual(['detected', 'outcome']);
  });
});
