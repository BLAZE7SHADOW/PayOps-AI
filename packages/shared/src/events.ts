/** Socket.IO rooms and event names (docs/03-agent-system.md §16). */
export const ROOMS = {
  ops: 'ops',
  case: (caseId: string) => `case:${caseId}`,
} as const;

export const OPS_EVENTS = {
  caseCreated: 'case.created',
  caseUpdated: 'case.updated',
  approvalRequested: 'approval.requested',
  approvalResolved: 'approval.resolved',
} as const;

export const RUN_EVENTS = [
  'run.started',
  'node.started',
  'node.completed',
  'tool.called',
  'tool.completed',
  'decision.made',
  'finding.created',
  'grounding.completed',
  'proposal.created',
  'policy.decided',
  'approval.requested',
  'approval.resolved',
  'execution.step',
  'validation.completed',
  'run.replanning',
  'run.completed',
  'run.failed',
] as const;
export type RunEventName = (typeof RUN_EVENTS)[number];
