/** Wires the Phase 3 graph (docs/03-agent-system.md §5, narrowed per docs/06-phases.md Phase 3). */
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { AgentDeps } from './deps';
import { buildNodes } from './nodes';
import { PayOpsState, type PayOpsStateType } from './state';

export function buildGraph(deps: AgentDeps, checkpointer: BaseCheckpointSaver) {
  const nodes = buildNodes(deps);

  const graph = new StateGraph(PayOpsState)
    .addNode('loadCase', nodes.loadCase)
    .addNode('triage', nodes.triage)
    .addNode('diagnose', nodes.diagnose)
    .addNode('investigate', nodes.investigate)
    .addNode('resolve', nodes.resolve)
    .addNode('policyGate', nodes.policyGate)
    .addNode('awaitApproval', nodes.awaitApproval)
    .addNode('execute', nodes.execute)
    .addNode('closeBlocked', nodes.closeBlocked)
    .addNode('closeRejected', nodes.closeRejected)
    .addNode('closeEscalated', nodes.closeEscalated)
    .addEdge(START, 'loadCase')
    .addEdge('loadCase', 'triage')
    .addEdge('triage', 'diagnose')
    .addConditionalEdges(
      'diagnose',
      (state: PayOpsStateType) => (state.diagnosis ? 'resolve' : 'investigate'),
      { resolve: 'resolve', investigate: 'investigate' },
    )
    .addEdge('investigate', 'resolve')
    .addEdge('resolve', 'policyGate')
    .addConditionalEdges(
      'policyGate',
      (state: PayOpsStateType) => {
        const tier = state.policy?.tier;
        if (tier === 'AUTO') return 'execute';
        if (tier === 'BLOCKED') return 'closeBlocked';
        return 'awaitApproval';
      },
      { execute: 'execute', closeBlocked: 'closeBlocked', awaitApproval: 'awaitApproval' },
    )
    .addConditionalEdges(
      'awaitApproval',
      (state: PayOpsStateType) => {
        const d = state.approval?.decision;
        if (d === 'APPROVE') return 'execute';
        if (d === 'REJECT') return 'closeRejected';
        return 'closeEscalated';
      },
      { execute: 'execute', closeRejected: 'closeRejected', closeEscalated: 'closeEscalated' },
    )
    .addEdge('execute', END)
    .addEdge('closeBlocked', END)
    .addEdge('closeRejected', END)
    .addEdge('closeEscalated', END);

  return graph.compile({ checkpointer });
}
