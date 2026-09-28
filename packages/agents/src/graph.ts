/**
 * Wires the graph (docs/03-agent-system.md §5). Phase 4 task 3 replaces the single `investigate`
 * node with `plan` (J2) fanning out to the Payment/Reconciliation/Risk specialists in parallel
 * via LangGraph `Send`, converging on `join`. Phase 4 task 6 adds `groundCheck` (J4) between
 * `join` and `resolve`, with a conditional edge back to `plan` for one targeted extra
 * investigation round when the evidence is insufficient and the round budget allows it (§4 "J4",
 * §5's `groundCheck -> plan` arrow). Phase 5 task 1 (docs/DECISIONS.md D047) splits the old
 * single `execute` node into `execute -> validate`, and adds `closeResolved` (PASS) and `replan`
 * (J5, PARTIAL/FAIL) after it: `replan` either closes via `closeEscalated`
 * (`escalate_to_human`) or loops back to `resolve` (`retry_same_action`/`alternative_action`) or
 * `plan` (`reinvestigate`). The fast path (`diagnose` -> `resolve` directly) never touches
 * `plan`, the specialists, `join` or `groundCheck` -- unchanged by this task. Phase 5 task 5
 * (docs/DECISIONS.md D049) adds a budget guard checked at every node up to and including
 * `resolve`: any of them can route to `closeEscalated` early via `state.status ===
 * 'ESCALATED'`, set by `nodes.ts`'s `guardBudget` rather than by a new state field.
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
    .addNode('validate', nodes.validate)
    .addNode('closeResolved', nodes.closeResolved)
    .addNode('replan', nodes.replan)
    .addNode('closeBlocked', nodes.closeBlocked)
    .addNode('closeRejected', nodes.closeRejected)
    .addNode('closeEscalated', nodes.closeEscalated)
    .addEdge(START, 'loadCase')
    .addEdge('loadCase', 'triage')
    // Phase 5 task 5 budget guard (docs/DECISIONS.md D049): every conditional edge from here up
    // to and including `resolve` checks `state.status === 'ESCALATED'` first and routes to
    // `closeEscalated` -- `guardBudget` (nodes.ts) is the only thing that can set that status on
    // this stretch of the graph before `policyGate` ever runs.
    .addConditionalEdges(
      'triage',
      (state: PayOpsStateType) => (state.status === 'ESCALATED' ? 'closeEscalated' : 'diagnose'),
      { diagnose: 'diagnose', closeEscalated: 'closeEscalated' },
    )
    .addConditionalEdges(
      'diagnose',
      (state: PayOpsStateType) => {
        if (state.status === 'ESCALATED') return 'closeEscalated';
        return state.diagnosis ? 'resolve' : 'plan';
      },
      { resolve: 'resolve', plan: 'plan', closeEscalated: 'closeEscalated' },
    )
    // Parallel fan-out: only the specialists `plan` selected receive a `Send`, so a specialist
    // `plan` did not choose never runs (and therefore never contributes evidence/findings).
    .addConditionalEdges(
      'plan',
      (state: PayOpsStateType) => {
        if (state.status === 'ESCALATED') return 'closeEscalated';
        const specialists = state.investigationPlan?.specialists ?? [...AGENT_NAMES];
        return specialists.map((s) => new Send(SPECIALIST_NODE[s], state));
      },
      ['paymentAgent', 'reconciliationAgent', 'riskAgent', 'closeEscalated'],
    )
    .addEdge('paymentAgent', 'join')
    .addEdge('reconciliationAgent', 'join')
    .addEdge('riskAgent', 'join')
    // `join` is the first point after the parallel fan-out where the specialists' combined
    // tool/LLM spend is visible on the merged state, so this is where the budget guard is
    // actually checked for that spend (nodes.ts's `join`, docs/DECISIONS.md D049).
    .addConditionalEdges(
      'join',
      (state: PayOpsStateType) => (state.status === 'ESCALATED' ? 'closeEscalated' : 'groundCheck'),
      { groundCheck: 'groundCheck', closeEscalated: 'closeEscalated' },
    )
    // docs/03 §5: "groundCheck -+-> (gaps & rounds<2) -> plan / -> resolve". `groundCheck`
    // (nodes.ts) only ever populates `gaps` when `applyGroundingRules` decided a targeted extra
    // round is warranted (insufficient evidence and the round cap not yet spent), so a non-empty
    // `gaps` is itself the whole condition -- the round cap is enforced inside that function, not
    // re-checked here.
    .addConditionalEdges(
      'groundCheck',
      (state: PayOpsStateType) => {
        if (state.status === 'ESCALATED') return 'closeEscalated';
        return state.gaps.length > 0 ? 'plan' : 'resolve';
      },
      { plan: 'plan', resolve: 'resolve', closeEscalated: 'closeEscalated' },
    )
    // Still before `policyGate` creates a resolution row, so a guard trip inside `resolve`
    // itself (its own LLM diagnosis call) also routes here rather than to `policyGate`.
    .addConditionalEdges(
      'resolve',
      (state: PayOpsStateType) => (state.status === 'ESCALATED' ? 'closeEscalated' : 'policyGate'),
      { policyGate: 'policyGate', closeEscalated: 'closeEscalated' },
    )
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
    // execute -> validate, except an execution failure (docs/03 §5): `execute` itself already
    // closed and escalated in that case (see nodes.ts), so there is nothing left for `validate`
    // to check -- `state.status` is the only signal since `execute`'s `PayOpsUpdate` return is
    // otherwise indistinguishable from the success case at this point in the graph.
    .addConditionalEdges(
      'execute',
      (state: PayOpsStateType) => (state.status === 'ESCALATED' ? END : 'validate'),
      { validate: 'validate', [END]: END },
    )
    .addConditionalEdges(
      'validate',
      (state: PayOpsStateType) => (state.validation?.verdict === 'PASS' ? 'closeResolved' : 'replan'),
      { closeResolved: 'closeResolved', replan: 'replan' },
    )
    // replan's three routes (docs/03 §13), derived from what `replan` already put in state
    // rather than a separate "strategy" field (docs/DECISIONS.md D047): `status === 'ESCALATED'`
    // is only ever set here for `escalate_to_human`; `diagnosis === null` only for
    // `reinvestigate` (it deliberately clears a stale diagnosis); otherwise `retry_same_action`/
    // `alternative_action`, which are the same route (a fresh proposal via `resolve`).
    .addConditionalEdges(
      'replan',
      (state: PayOpsStateType) => {
        if (state.status === 'ESCALATED') return 'closeEscalated';
        return state.diagnosis === null ? 'plan' : 'resolve';
      },
      { closeEscalated: 'closeEscalated', plan: 'plan', resolve: 'resolve' },
    )
    .addEdge('closeResolved', END)
    .addEdge('closeBlocked', END)
    .addEdge('closeRejected', END)
    .addEdge('closeEscalated', END);

  return graph.compile({ checkpointer });
}
