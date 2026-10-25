/** Policy, approval, execution, validation and the replan decision (J5). */
import { interrupt } from '@langchain/langgraph';
import { agentWriteContext, choice } from '@payops/core';
import { AGENT_BUDGET_LIMITS, zeroBudget, type AgentApprovalDecision, type AttemptSummary, type ReplanStrategy, type RunStatus } from '@payops/shared';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import { REPLAN_STRATEGY_CRITERIA } from './criteria';
import { errorMessage, type NodeContext } from './shared';

export function buildControlNodes({ core, decision, onEvent }: NodeContext) {
  async function policyGate(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('policyGate', 'NODE_STARTED', {});
    const proposal = state.proposal!;
    const diagnosis = state.diagnosis!;
    const { resolution, approvalId } = await core.resolutions.proposeFromAgent(
      state.caseId,
      state.runId,
      { actions: proposal.actions, rationale: proposal.rationale },
      { diagnosisConfidence: diagnosis.confidence, groundingViolations: 0 },
    );
    await onEvent('policyGate', 'POLICY_DECIDED', { tier: resolution.policy.tier, reasons: resolution.policy.reasons, resolutionId: resolution.id });
    let status: RunStatus = 'EXECUTING';
    if (resolution.policy.tier === 'BLOCKED') status = 'ESCALATED';
    else if (resolution.policy.tier === 'OPS' || resolution.policy.tier === 'MANAGER') status = 'AWAITING_APPROVAL';
    if (approvalId) await onEvent('policyGate', 'APPROVAL_REQUESTED', { approvalId, tier: resolution.policy.tier });
    await onEvent('policyGate', 'NODE_COMPLETED', { tier: resolution.policy.tier });
    return { policy: resolution.policy, resolutionId: resolution.id, approvalId, attempt: resolution.attempt, status };
  }

  /** Pauses the run until a person decides; the decision arrives as the resume value. */
  async function awaitApproval(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('awaitApproval', 'NODE_STARTED', { approvalId: state.approvalId });
    const decided = interrupt({ approvalId: state.approvalId, tier: state.policy?.tier, proposal: state.proposal }) as AgentApprovalDecision;
    await onEvent('awaitApproval', 'APPROVAL_RESOLVED', { decision: decided.decision });
    const status: RunStatus = decided.decision === 'APPROVE' ? 'EXECUTING' : decided.decision === 'REJECT' ? 'REJECTED' : 'ESCALATED';
    return { approval: decided, status };
  }

  /**
   * Runs the proposal's actions. A failed action closes and escalates here (it never reaches `replan`);
   * only a validator PARTIAL or FAIL does. An error thrown by the executor itself escalates the existing
   * resolution rather than crashing the run.
   */
  async function execute(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('execute', 'NODE_STARTED', { resolutionId: state.resolutionId });
    const write = agentWriteContext(state.caseId, state.runId);
    try {
      const { execution } = await core.resolutions.execute(state.resolutionId!, write);
      await onEvent('execute', 'EXECUTION_STEP', { executions: execution.steps });
      if (!execution.ok) {
        await core.resolutions.closeExecutionFailed(state.resolutionId!, execution, write, { onFailure: 'ESCALATE' });
        await onEvent('execute', 'RUN_COMPLETED', { status: 'ESCALATED' });
        return { executions: execution.steps, status: 'ESCALATED' };
      }
      await onEvent('execute', 'NODE_COMPLETED', {});
      return { executions: execution.steps };
    } catch (err) {
      const message = errorMessage(err);
      await core.resolutions.escalateExecutionError(state.resolutionId!, message, write);
      await onEvent('execute', 'RUN_COMPLETED', { status: 'ESCALATED', fallback: true, error: message });
      return { status: 'ESCALATED', error: message };
    }
  }

  /** Checks the executed resolution against fresh data. Does not close it: `replan` may still decide to. */
  async function validate(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('validate', 'NODE_STARTED', { resolutionId: state.resolutionId });
    const result = await core.resolutions.validate(state.resolutionId!);
    const validation = { verdict: result.verdict, checks: result.checks };
    await onEvent('validate', 'VALIDATION_COMPLETED', { validation });
    await onEvent('validate', 'NODE_COMPLETED', {});
    return { validation };
  }

  /**
   * J5, reached after a PARTIAL or FAIL. Code caps win over Jev and cost no call: the attempt cap and a
   * confidence floor of 0.5 both mean `escalate_to_human`. `retry_same_action` and `alternative_action`
   * take the same route (a fresh proposal through `resolve`); only `reinvestigate` clears the diagnosis (D047).
   */
  async function replan(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('replan', 'NODE_STARTED', { attempt: state.attempt });
    const validation = state.validation!;
    const failedChecks = validation.checks.filter((c) => !c.pass).map((c) => c.id);
    const validatorNotes = `Validator ${validation.verdict}: ${failedChecks.length ? failedChecks.join(', ') : 'an invariant'} failed on attempt ${state.attempt}.`;
    const summary: AttemptSummary = { attempt: state.attempt, actions: state.proposal?.actions ?? [], failedChecks, validatorNotes, verdict: validation.verdict };

    if (state.attempt >= AGENT_BUDGET_LIMITS.maxAttempts) {
      await onEvent('replan', 'NODE_COMPLETED', { strategy: 'escalate_to_human', reason: 'attempt cap' });
      return { history: [summary], status: 'ESCALATED' };
    }

    try {
      const result = await decision.ask({
        tag: 'J5_REPLAN',
        state: { attempt: state.attempt, failedChecks, validatorNotes },
        questions: { strategy: choice('What should happen next, given this attempt failed verification?', REPLAN_STRATEGY_CRITERIA) },
      });
      await onEvent('replan', 'DECISION_MADE', { tag: 'J5_REPLAN', answers: result.answers, usage: result.usage });
      const budget = { ...zeroBudget(), jevCalls: 1, tokensIn: result.usage.input_tokens, tokensOut: result.usage.output_tokens };
      const strategy: ReplanStrategy = result.answers.strategy.confidence < 0.5 ? 'escalate_to_human' : result.answers.strategy.choice;
      await onEvent('replan', 'NODE_COMPLETED', { strategy, confidence: result.answers.strategy.confidence });
      if (strategy === 'escalate_to_human') return { history: [summary], status: 'ESCALATED', budget };
      await onEvent('replan', 'RUN_REPLANNING', { strategy, nextAttempt: state.attempt + 1 });
      if (strategy === 'reinvestigate') return { history: [summary], diagnosis: null, gaps: [], investigationRound: 0, budget };
      return { history: [summary], budget };
    } catch (err) {
      await onEvent('replan', 'NODE_COMPLETED', { strategy: 'escalate_to_human', fallback: true, error: errorMessage(err) });
      return { history: [summary], status: 'ESCALATED', budget: { ...zeroBudget(), jevCalls: 1 } };
    }
  }

  return { policyGate, awaitApproval, execute, validate, replan };
}
