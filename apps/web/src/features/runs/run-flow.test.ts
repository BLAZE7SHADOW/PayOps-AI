import type { AgentStepItem } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { buildRunFlow } from './run-flow';

function step(seq: number, node: string, kind: AgentStepItem['kind']): AgentStepItem {
  return { id: `step_${seq}`, runId: 'run_1', seq, node, kind, payload: {}, at: new Date(seq * 1000).toISOString() };
}

describe('buildRunFlow', () => {
  it('shows only the selected specialist branches and keeps their recorded actions', () => {
    const flow = buildRunFlow([
      step(1, 'plan', 'NODE_STARTED'), step(2, 'plan', 'DECISION_MADE'), step(3, 'plan', 'NODE_COMPLETED'),
      step(4, 'paymentAgent', 'NODE_STARTED'), step(5, 'riskAgent', 'NODE_STARTED'),
      step(6, 'paymentAgent', 'TOOL_COMPLETED'), step(7, 'paymentAgent', 'NODE_COMPLETED'),
      step(8, 'riskAgent', 'DECISION_MADE'), step(9, 'riskAgent', 'NODE_COMPLETED'),
      step(10, 'join', 'NODE_STARTED'), step(11, 'join', 'NODE_COMPLETED'),
    ], 'INVESTIGATING');

    expect(flow.map((stage) => stage.key)).toEqual(['planning', 'specialists', 'grounding']);
    expect(flow[1]?.visits.map((visit) => visit.node)).toEqual(['paymentAgent', 'riskAgent']);
    expect(flow[1]?.visits[0]?.steps.map((event) => event.kind)).toEqual(['NODE_STARTED', 'TOOL_COMPLETED', 'NODE_COMPLETED']);
    expect(flow[1]?.state).toBe('COMPLETED');
  });

  it('shows an approval pause distinctly and omits unvisited stages', () => {
    const flow = buildRunFlow([
      step(1, 'diagnose', 'NODE_STARTED'), step(2, 'diagnose', 'NODE_COMPLETED'),
      step(3, 'resolve', 'NODE_STARTED'), step(4, 'resolve', 'NODE_COMPLETED'),
      step(5, 'policyGate', 'NODE_STARTED'), step(6, 'policyGate', 'NODE_COMPLETED'),
      step(7, 'awaitApproval', 'NODE_STARTED'),
    ], 'AWAITING_APPROVAL');

    expect(flow.map((stage) => stage.key)).toEqual(['planning', 'proposal', 'policy']);
    expect(flow[2]?.state).toBe('WAITING');
    expect(flow[2]?.visits[1]?.state).toBe('WAITING');
  });

  it('shows a second proposal after replan rather than merging two attempts', () => {
    const flow = buildRunFlow([
      step(1, 'resolve', 'NODE_STARTED'), step(2, 'resolve', 'NODE_COMPLETED'),
      step(3, 'validate', 'NODE_STARTED'), step(4, 'validate', 'NODE_COMPLETED'),
      step(5, 'replan', 'NODE_STARTED'), step(6, 'replan', 'NODE_COMPLETED'),
      step(7, 'resolve', 'NODE_STARTED'), step(8, 'resolve', 'NODE_COMPLETED'),
    ], 'RESOLVED');

    expect(flow.map((stage) => stage.key)).toEqual(['proposal', 'verification', 'replan', 'proposal']);
    expect(flow[3]?.visits[0]?.steps.map((event) => event.seq)).toEqual([7, 8]);
  });

  it('marks a resolved approval as complete even though that node has no completion event', () => {
    const flow = buildRunFlow([step(1, 'awaitApproval', 'NODE_STARTED'), step(2, 'awaitApproval', 'NODE_STARTED'), step(3, 'awaitApproval', 'APPROVAL_RESOLVED')], 'RESOLVED');
    expect(flow[0]?.state).toBe('COMPLETED');
    expect(flow[0]?.visits.map((visit) => visit.state)).toEqual(['PAUSED', 'COMPLETED']);
  });
});
