/**
 * Wires the graph (docs/03-agent-system.md §5). Phase 4 task 3 replaces the single `investigate`
 * node with `plan` (J2) fanning out to the Payment/Reconciliation/Risk specialists in parallel
 * via LangGraph `Send`, converging on `join`. Phase 4 task 6 adds `groundCheck` (J4) between
 * `join` and `resolve`, with a conditional edge back to `plan` for one targeted extra
 * investigation round when the evidence is insufficient and the round budget allows it (§4 "J4",
 * §5's `groundCheck -> plan` arrow). `replan` is still a later Phase 5 task. The fast path
 * (`diagnose` -> `resolve` directly) never touches `plan`, the specialists, `join` or
 * `groundCheck` -- unchanged by this task.
 */
import { END, Send, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { AGENT_NAMES, type AgentName } from '@payops/shared';
import type { AgentDeps } from './deps';
import { buildNodes } from './nodes';
import { PayOpsState, type PayOpsStateType } from './state';

/** Graph node each specialist's `AgentName` fans out to (docs/03 §5). */
const SPECIALIST_NODE: Record<AgentName, string> = {
  payment: 'paymentAgent',
  reconciliation: 'reconciliationAgent',
  risk: 'riskAgent',
};

export function buildGraph(deps: AgentDeps, checkpointer: BaseCheckpointSaver) {
  const nodes = buildNodes(deps);

  const graph = new StateGraph(PayOpsState)
    .addNode('loadCase', nodes.loadCase)
    .addNode('triage', nodes.triage)
    .addNode('diagnose', nodes.diagnose)
    .addNode('plan', nodes.plan)
    .addNode('paymentAgent', nodes.paymentAgent)
    .addNode('reconciliationAgent', nodes.reconciliationAgent)
    .addNode('riskAgent', nodes.riskAgent)
    .addNode('join', nodes.join)
    .addNode('groundCheck', nodes.groundCheck)
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
      (state: PayOpsStateType) => (state.diagnosis ? 'resolve' : 'plan'),
      { resolve: 'resolve', plan: 'plan' },
    )
    // Parallel fan-out: only the specialists `plan` selected receive a `Send`, so a specialist
    // `plan` did not choose never runs (and therefore never contributes evidence/findings).
    .addConditionalEdges(
      'plan',
      (state: PayOpsStateType) => {
        const specialists = state.plan?.specialists ?? [...AGENT_NAMES];
        return specialists.map((s) => new Send(SPECIALIST_NODE[s], state));
      },
      ['paymentAgent', 'reconciliationAgent', 'riskAgent'],
    )
    .addEdge('paymentAgent', 'join')
    .addEdge('reconciliationAgent', 'join')
    .addEdge('riskAgent', 'join')
    .addEdge('join', 'groundCheck')
    // docs/03 §5: "groundCheck -+-> (gaps & rounds<2) -> plan / -> resolve". `groundCheck`
    // (nodes.ts) only ever populates `gaps` when `applyGroundingRules` decided a targeted extra
    // round is warranted (insufficient evidence and the round cap not yet spent), so a non-empty
    // `gaps` is itself the whole condition -- the round cap is enforced inside that function, not
    // re-checked here.
    .addConditionalEdges(
      'groundCheck',
      (state: PayOpsStateType) => (state.gaps.length > 0 ? 'plan' : 'resolve'),
      { plan: 'plan', resolve: 'resolve' },
    )
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
