import { describe, expect, it } from 'vitest';
import { buildRunDetail } from './run-detail';
import { ev, fullRun, run } from './run-detail.fixtures';

describe('buildRunDetail', () => {
  const detail = buildRunDetail(run(), fullRun);
  const stepFor = (node: string) => detail.steps.find((s) => s.node === node)!;

  it('summarizes how the run was routed', () => {
    expect(detail.overview.path).toBe('FULL');
    expect(detail.overview.specialists.map((s) => s.name)).toEqual(['payment', 'reconciliation', 'risk']);
    expect(detail.overview.replans).toBe(0);
    expect(detail.overview.lines.join(' ')).toMatch(/full investigation/i);
  });

  it('numbers the steps and labels fixed versus case-specific steps', () => {
    expect(detail.steps.map((s) => s.number)).toEqual(detail.steps.map((_, i) => i + 1));
    expect(stepFor('triage').mode).toBe('FIXED');
    expect(stepFor('paymentAgent').mode).toBe('DYNAMIC');
    expect(stepFor('paymentAgent').modeNote).toMatch(/chosen/i);
  });

  it('explains why the fast path was or was not taken, with the recorded numbers', () => {
    const d = stepFor('diagnose');
    expect(d.why.join(' ')).toContain('71%');
    expect(d.why.join(' ')).toMatch(/80%/);
    expect(d.next).toMatch(/Plan/);
    expect(d.next).toMatch(/fast path was not taken/i);
    expect(d.calls.some((c) => c.kind === 'jev' && c.lines.join(' ').includes('root_cause'))).toBe(true);
  });

  it('shows what a specialist called and why, including the extra records it asked for', () => {
    const p = stepFor('paymentAgent');
    const tools = p.calls.find((c) => c.kind === 'tools')!;
    expect(tools.lines.join(' ')).toContain('ev_03');
    const model = p.calls.filter((c) => c.kind === 'model');
    expect(model.map((c) => c.title).join(' ')).toMatch(/extra records/i);
    expect(p.why.join(' ')).toContain('See why the order is FAILED.');
    expect(p.why.join(' ')).toMatch(/not run|not read|suggested/i);
    expect(p.findings.map((f) => f.id)).toEqual(['fd_01']);
    expect(p.facts.map((f) => f.evidenceId)).toEqual(['ev_03']);
  });

  it('says a skipped specialist had no records to work with', () => {
    const r = stepFor('reconciliationAgent');
    expect(r.found.join(' ')).toMatch(/no relevant records/i);
  });

  it('states the next step and the reason from the recorded routing', () => {
    expect(stepFor('policyGate').next).toMatch(/Execute/);
    expect(stepFor('policyGate').next).toMatch(/AUTO/);
    expect(stepFor('validate').next).toMatch(/resolved/i);
    expect(stepFor('closeResolved').next).toBeNull();
    expect(stepFor('plan').next).toMatch(/payment.*reconciliation.*risk/i);
  });

  it('hides steps that only exist as plumbing and keeps the rest in order', () => {
    expect(detail.steps.map((s) => s.node)).toEqual([
      'triage', 'diagnose', 'plan', 'paymentAgent', 'reconciliationAgent', 'groundCheck', 'resolve', 'policyGate', 'execute', 'validate', 'closeResolved',
    ]);
  });

  it('explains a targeted extra round when evidence had gaps', () => {
    const gap = buildRunDetail(run(), [
      ev('groundCheck', 'NODE_STARTED'), ev('groundCheck', 'NODE_COMPLETED', { violations: [], sufficient: false, gaps: ['ledger entries'] }),
      ev('plan', 'NODE_STARTED'), ev('plan', 'NODE_COMPLETED', { specialists: ['reconciliation'], routedBy: 'GAP_TARGETED', targeted: true, gaps: ['ledger entries'] }),
    ]);
    expect(gap.steps[0]!.next).toMatch(/Plan/);
    expect(gap.steps[0]!.next).toContain('ledger entries');
    expect(gap.steps[1]!.modeNote).toContain('ledger entries');
    expect(gap.overview.extraRounds).toBe(1);
  });

  it('shows what replanning chose after a failed verification', () => {
    const replan = buildRunDetail(run({ attempt: 2 }), [
      ev('validate', 'NODE_STARTED'), ev('validate', 'VALIDATION_COMPLETED', { validation: { verdict: 'FAIL', checks: [{ pass: false, description: 'Order is paid' }] } }), ev('validate', 'NODE_COMPLETED', {}),
      ev('replan', 'NODE_STARTED', { attempt: 1 }), ev('replan', 'DECISION_MADE', { tag: 'J5_REPLAN', answers: { strategy: { type: 'choice', choice: 'alternative_action', confidence: 0.8 } } }),
      ev('replan', 'NODE_COMPLETED', { strategy: 'alternative_action', confidence: 0.8 }),
    ]);
    expect(replan.steps[0]!.next).toMatch(/Replan/i);
    expect(replan.steps[1]!.mode).toBe('DYNAMIC');
    expect(replan.steps[1]!.why.join(' ')).toMatch(/alternative/i);
    expect(replan.overview.replans).toBe(1);
  });
});
