import { describe, expect, it } from 'vitest';
import type { CaseDetail } from '@payops/shared';
import { approvalAccess, caseProgress } from './case-progress';

function make(status: string, resolutions: unknown[] = []) {
  return { status, resolutionView: { resolutions } } as unknown as CaseDetail;
}
const pending = (tier: string, proposedBy: unknown) => [{ attempt: 1, proposedBy, approval: { tier, status: 'PENDING', decidedBy: null } }];
const agent = { type: 'AGENT', id: 'agent', name: 'Agent' };

describe('caseProgress', () => {
  const states = (status: string, res: unknown[] = []) => caseProgress(make(status, res)).map((s) => s.state);

  it('starts at the investigation for a new case', () => {
    expect(states('OPEN')).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  });
  it('waits at approval and names who must approve', () => {
    const stages = caseProgress(make('AWAITING_APPROVAL', pending('MANAGER', agent)));
    expect(stages.map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    expect(stages[2]!.note).toBe('Waiting for a manager');
  });
  it('stops an escalated case at a person, with nothing to approve', () => {
    const stages = caseProgress(make('ESCALATED'));
    expect(stages[2]).toMatchObject({ state: 'stopped', label: 'Handed to a person', note: 'Nothing to approve yet' });
    expect(stages[3]!.state).toBe('upcoming');
  });
  it('shows a rejected proposal as stopped with nothing changed', () => {
    expect(caseProgress(make('REJECTED'))[2]).toMatchObject({ state: 'stopped', label: 'Rejected', note: 'Nothing was changed' });
  });
  it('marks every stage done when resolved, with the approver or "Not needed"', () => {
    expect(states('RESOLVED')).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(caseProgress(make('RESOLVED'))[2]!.note).toBe('Not needed');
    const approved = [{ attempt: 1, approval: { tier: 'OPS', status: 'APPROVED', decidedBy: { name: 'Asha' } } }];
    expect(caseProgress(make('RESOLVED', approved))[2]!.note).toBe('Approved by Asha');
  });
  it('runs the fix after approval', () => {
    expect(states('EXECUTING')).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
  });
});

describe('approvalAccess', () => {
  it('is null when nothing is pending', () => {
    expect(approvalAccess(make('ESCALATED'), { id: 'u1', role: 'MANAGER' })).toBeNull();
  });
  it('lets a manager approve an agent proposal', () => {
    const a = approvalAccess(make('AWAITING_APPROVAL', pending('MANAGER', agent)), { id: 'u1', role: 'MANAGER' });
    expect(a).toMatchObject({ canApprove: true });
    expect(a!.text).toContain('A manager (or admin) must approve');
    expect(a!.text).toContain('You can approve it.');
  });
  it('says an operator cannot approve a manager-tier fix', () => {
    const a = approvalAccess(make('AWAITING_APPROVAL', pending('MANAGER', agent)), { id: 'u1', role: 'OPS' });
    expect(a).toMatchObject({ canApprove: false });
    expect(a!.text).toContain('Your role cannot approve it.');
  });
  it('applies four-eyes to the person who proposed it', () => {
    const person = { type: 'USER', id: 'u1', name: 'Ravi' };
    const mine = approvalAccess(make('AWAITING_APPROVAL', pending('OPS', person)), { id: 'u1', role: 'OPS' });
    expect(mine).toMatchObject({ canApprove: false });
    expect(mine!.text).toContain('You proposed it, so someone else must approve it.');
    expect(approvalAccess(make('AWAITING_APPROVAL', pending('OPS', person)), { id: 'u2', role: 'OPS' })).toMatchObject({ canApprove: true });
  });
});
