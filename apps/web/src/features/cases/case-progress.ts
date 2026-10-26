import type { CaseDetail, Role } from '@payops/shared';

export type StageState = 'done' | 'current' | 'stopped' | 'upcoming';

export interface Stage {
  key: 'detected' | 'investigated' | 'approval' | 'fix' | 'verified';
  label: string;
  state: StageState;
  /** One short phrase under the label: what happened, or what is happening now. */
  note: string;
}

function latestResolution(c: CaseDetail) {
  return [...(c.resolutionView?.resolutions ?? [])].sort((a, b) => b.attempt - a.attempt)[0];
}

function approverWords(tier: string | undefined): string {
  return tier === 'MANAGER' ? 'a manager' : tier === 'OPS' ? 'an operator' : 'an approver';
}

/**
 * The whole path of a case in five stages, so "where is this and what is left" is visible at a glance.
 * Derived only from the case status and its latest resolution (same inputs as the verdict line).
 */
export function caseProgress(c: CaseDetail): Stage[] {
  const latest = latestResolution(c);
  const approval = latest?.approval ?? null;
  const approvedBy = approval?.decidedBy?.name ?? null;
  const stage = (key: Stage['key'], label: string, state: StageState, note: string): Stage => ({ key, label, state, note });
  const detected = stage('detected', 'Detected', 'done', 'Flagged by the system');

  switch (c.status) {
    case 'OPEN':
      return [detected, stage('investigated', 'Investigated', 'current', 'Not started'), stage('approval', 'Approval', 'upcoming', 'If policy needs it'),
        stage('fix', 'Fix applied', 'upcoming', ''), stage('verified', 'Verified', 'upcoming', '')];
    case 'INVESTIGATING':
      return [detected, stage('investigated', 'Investigated', 'current', 'Running now'), stage('approval', 'Approval', 'upcoming', 'If policy needs it'),
        stage('fix', 'Fix applied', 'upcoming', ''), stage('verified', 'Verified', 'upcoming', '')];
    case 'AWAITING_APPROVAL':
      return [detected, stage('investigated', 'Investigated', 'done', 'Fix proposed'), stage('approval', 'Approval', 'current', `Waiting for ${approverWords(approval?.tier)}`),
        stage('fix', 'Fix applied', 'upcoming', 'After approval'), stage('verified', 'Verified', 'upcoming', '')];
    case 'EXECUTING':
      return [detected, stage('investigated', 'Investigated', 'done', 'Fix proposed'), stage('approval', 'Approval', 'done', approvedBy ? `Approved by ${approvedBy}` : 'Approved'),
        stage('fix', 'Fix applied', 'current', 'Running now'), stage('verified', 'Verified', 'upcoming', 'After the fix')];
    case 'RESOLVED':
      return [detected, stage('investigated', 'Investigated', 'done', 'Done'), stage('approval', 'Approval', 'done', approvedBy ? `Approved by ${approvedBy}` : 'Not needed'),
        stage('fix', 'Fix applied', 'done', 'Done'), stage('verified', 'Verified', 'done', 'Records re-read')];
    case 'ESCALATED':
      return [detected, stage('investigated', 'Investigated', 'done', 'No safe fix found'), stage('approval', 'Handed to a person', 'stopped', 'Nothing to approve yet'),
        stage('fix', 'Fix applied', 'upcoming', 'After a person acts'), stage('verified', 'Verified', 'upcoming', '')];
    case 'REJECTED':
      return [detected, stage('investigated', 'Investigated', 'done', 'Fix proposed'), stage('approval', 'Rejected', 'stopped', 'Nothing was changed'),
        stage('fix', 'Fix applied', 'upcoming', 'Not run'), stage('verified', 'Verified', 'upcoming', '')];
    default:
      return [detected];
  }
}

export interface ApprovalAccess {
  /** One sentence: who must approve, and whether that is the viewer. */
  text: string;
  canApprove: boolean;
}

const RANK: Record<Role, number> = { VIEWER: 0, OPS: 1, MANAGER: 2, ADMIN: 3 };

/** Who can approve the pending fix and whether the signed-in person is one of them (role and four-eyes, as the server checks them). */
export function approvalAccess(c: CaseDetail, user: { id: string; role: Role } | null): ApprovalAccess | null {
  const latest = latestResolution(c);
  const approval = latest?.approval;
  if (!latest || !approval || approval.status !== 'PENDING') return null;
  const needed: Role = approval.tier === 'MANAGER' ? 'MANAGER' : 'OPS';
  const who = approval.tier === 'MANAGER' ? 'A manager (or admin)' : 'An operator, manager or admin';
  const proposer = latest.proposedBy.type === 'USER' ? latest.proposedBy.name : 'the agent';
  const base = `${who} must approve. It was proposed by ${proposer}.`;
  if (!user || RANK[user.role] < RANK[needed]) return { text: `${base} Your role cannot approve it.`, canApprove: false };
  if (latest.proposedBy.type === 'USER' && latest.proposedBy.id === user.id) return { text: `${base} You proposed it, so someone else must approve it.`, canApprove: false };
  return { text: `${base} You can approve it.`, canApprove: true };
}
