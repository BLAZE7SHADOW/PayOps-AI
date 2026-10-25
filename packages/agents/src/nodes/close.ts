/** The ways a run ends. */
import { agentWriteContext } from '@payops/core';
import type { RunStatus } from '@payops/shared';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import type { NodeContext } from './shared';

export function buildCloseNodes({ core, onEvent }: NodeContext) {
  /** The validator passed: close the resolution, and the run ends ESCALATED if the fix itself was an escalation. */
  async function closeResolved(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('closeResolved', 'NODE_STARTED', {});
    await core.resolutions.closeValidated(state.resolutionId!, 'PASS', agentWriteContext(state.caseId, state.runId), { onFailure: 'ESCALATE' });
    const escalates = (state.proposal?.actions ?? []).some((a) => a.type === 'ESCALATE_TO_HUMAN');
    const status: RunStatus = escalates ? 'ESCALATED' : 'RESOLVED';
    await onEvent('closeResolved', 'RUN_COMPLETED', { status });
    return { status };
  }

  async function closeBlocked(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED', reason: 'BLOCKED by policy' });
    return { status: 'ESCALATED' };
  }

  async function closeRejected(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'REJECTED' });
    return { status: 'REJECTED' };
  }

  /**
   * Reached from three places. After a validated attempt that `replan` gave up on, the resolution is still
   * open, so it is closed here. After a budget-guard trip before `policyGate` there is no resolution, so only
   * the case is escalated. Other routes (an approver's ESCALATE, a BLOCKED tier) already closed everything.
   */
  async function closeEscalated(state: PayOpsStateType): Promise<PayOpsUpdate> {
    const write = agentWriteContext(state.caseId, state.runId);
    if (state.validation) {
      await core.resolutions.closeValidated(state.resolutionId!, state.validation.verdict, write, { onFailure: 'ESCALATE' });
    } else if (!state.resolutionId && state.error) {
      await core.resolutions.escalateWithoutProposal(state.caseId, state.error, write);
    }
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED', ...(state.error ? { reason: state.error } : {}) });
    return { status: 'ESCALATED' };
  }

  return { closeResolved, closeBlocked, closeRejected, closeEscalated };
}
