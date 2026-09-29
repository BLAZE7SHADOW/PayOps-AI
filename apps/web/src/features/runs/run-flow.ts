import type { AgentStepItem, RunStatus } from '@payops/shared';

export type FlowStageKey = 'intake' | 'planning' | 'specialists' | 'grounding' | 'proposal' | 'policy' | 'execution' | 'verification' | 'replan' | 'outcome' | 'other';
export type FlowState = 'COMPLETED' | 'RUNNING' | 'WAITING' | 'PAUSED' | 'FAILED' | 'STOPPED';

export interface NodeVisit {
  node: string;
  startedAt: string;
  steps: AgentStepItem[];
  state: FlowState;
}

export interface FlowStage {
  key: FlowStageKey;
  visits: NodeVisit[];
  state: FlowState;
}

const SPECIALISTS = new Set(['paymentAgent', 'reconciliationAgent', 'riskAgent']);

export const FLOW_LABEL: Record<FlowStageKey, string> = {
  intake: 'Load and triage',
  planning: 'Diagnosis and plan',
  specialists: 'Specialist branches',
  grounding: 'Combine and check evidence',
  proposal: 'Proposed resolution',
  policy: 'Policy and approval',
  execution: 'Deterministic execution',
  verification: 'Independent verification',
  replan: 'Replanning',
  outcome: 'Outcome',
  other: 'Other recorded work',
};

export const NODE_LABEL: Record<string, string> = {
  loadCase: 'Load case', triage: 'Triage', diagnose: 'Fast diagnosis', plan: 'Plan investigation',
  paymentAgent: 'Payment agent', reconciliationAgent: 'Reconciliation agent', riskAgent: 'Risk agent',
  join: 'Join specialist results', groundCheck: 'Check evidence grounding', resolve: 'Build proposal',
  policyGate: 'Apply policy', awaitApproval: 'Wait for human approval', execute: 'Execute approved action',
  validate: 'Verify the outcome', replan: 'Choose recovery', closeResolved: 'Resolved',
  closeBlocked: 'Blocked', closeRejected: 'Rejected', closeEscalated: 'Escalated',
};

function stageKey(node: string): FlowStageKey {
  if (node === 'loadCase' || node === 'triage') return 'intake';
  if (node === 'diagnose' || node === 'plan') return 'planning';
  if (SPECIALISTS.has(node)) return 'specialists';
  if (node === 'join' || node === 'groundCheck') return 'grounding';
  if (node === 'resolve') return 'proposal';
  if (node === 'policyGate' || node === 'awaitApproval') return 'policy';
  if (node === 'execute') return 'execution';
  if (node === 'validate') return 'verification';
  if (node === 'replan') return 'replan';
  if (node.startsWith('close')) return 'outcome';
  return 'other';
}

function visitState(visit: NodeVisit, runStatus: RunStatus): FlowState {
  if (visit.steps.some((step) => step.kind === 'RUN_FAILED')) return 'FAILED';
  if (visit.node === 'awaitApproval' && visit.steps.some((step) => step.kind === 'APPROVAL_RESOLVED')) return 'COMPLETED';
  if (visit.steps.some((step) => step.kind === 'NODE_COMPLETED' || step.kind === 'RUN_COMPLETED')) return 'COMPLETED';
  if (visit.node === 'awaitApproval' && runStatus === 'AWAITING_APPROVAL') return 'WAITING';
  if (visit.node === 'awaitApproval') return 'PAUSED';
  if (['INVESTIGATING', 'EXECUTING', 'VALIDATING'].includes(runStatus)) return 'RUNNING';
  return 'STOPPED';
}

/** The graph can revisit a node after replanning; each NODE_STARTED begins a separate visible visit. */
export function buildRunFlow(steps: AgentStepItem[], runStatus: RunStatus): FlowStage[] {
  const visits: NodeVisit[] = [];
  const latest = new Map<string, NodeVisit>();
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    let visit = latest.get(step.node);
    if (step.kind === 'NODE_STARTED' || !visit) {
      visit = { node: step.node, startedAt: step.at, steps: [], state: 'RUNNING' };
      visits.push(visit);
      latest.set(step.node, visit);
    }
    visit.steps.push(step);
  }
  for (const visit of visits) visit.state = visitState(visit, runStatus);

  const stages: FlowStage[] = [];
  for (const visit of visits) {
    const key = stageKey(visit.node);
    const last = stages.at(-1);
    if (last?.key === key) last.visits.push(visit);
    else stages.push({ key, visits: [visit], state: visit.state });
  }
  for (const stage of stages) {
    stage.state = stage.visits.some((visit) => visit.state === 'FAILED') ? 'FAILED'
      : stage.visits.some((visit) => visit.state === 'WAITING') ? 'WAITING'
      : stage.visits.some((visit) => visit.state === 'RUNNING') ? 'RUNNING'
      : stage.visits.some((visit) => visit.state === 'PAUSED') && stage.visits.some((visit) => visit.state === 'COMPLETED') ? 'COMPLETED'
      : stage.visits.some((visit) => visit.state === 'PAUSED') ? 'STOPPED'
      : stage.visits.some((visit) => visit.state === 'STOPPED') ? 'STOPPED' : 'COMPLETED';
  }
  return stages;
}
