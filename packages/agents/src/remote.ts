/**
 * What the Python agent service (python/agents, D085) may ask this process to do. The Python graph
 * reasons; everything that reads data, changes data or carries authority stays here: tools are run
 * over a freshly loaded `CaseState`, the policy gate, executor and validator are the same
 * `core.resolutions` calls the TypeScript graph makes, and agent steps and run rows are written with
 * the same store functions. `apps/server`'s `/internal/agent` routes are thin wrappers over these.
 */
import {
  AppError,
  agentWriteContext,
  loadCaseState,
  type Core,
} from '@payops/core';
import type {
  AttemptSummary,
  CaseBrief,
  Diagnosis,
  EntityRefs,
  PolicyDecision,
  ResolutionProposal,
  ExecutionStep,
  ValidationCheck,
  ValidationVerdict,
  RunStatus,
} from '@payops/shared';
import { buildCaseBrief } from './brief';
import { toAttemptHistory } from './nodes';
import { buildProposal } from './proposal';
import { syncRunRow } from './run';
import { createEventSink, patchRunRow, type RunPatch } from './store';
import { ALL_TOOLS, type ToolEvidenceDraft } from './tools';
import type { PayOpsStateType } from './state';

async function loadState(core: Core, caseId: string) {
  return loadCaseState(core.db, core.gateway, caseId, core.clock.now());
}

export async function remoteCaseBrief(core: Core, caseId: string): Promise<{ brief: CaseBrief; entityRefs: EntityRefs }> {
  const state = await loadState(core, caseId);
  return { brief: buildCaseBrief(state), entityRefs: state.case.entityRefs };
}

/** Runs the named tools, in the order given, over one fresh read of the case. */
export async function remoteRunTools(core: Core, caseId: string, names: readonly string[]): Promise<Array<{ tool: string; drafts: ToolEvidenceDraft[] }>> {
  const tools = names.map((name) => {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) throw new AppError('BAD_REQUEST', `Unknown tool ${name}`);
    return tool;
  });
  const state = await loadState(core, caseId);
  return tools.map((tool) => ({ tool: tool.name, drafts: tool.run(state) }));
}

export async function remoteProposal(core: Core, caseId: string, diagnosis: Diagnosis, history: readonly AttemptSummary[]): Promise<ResolutionProposal> {
  const state = await loadState(core, caseId);
  return buildProposal(diagnosis, state, toAttemptHistory(history));
}

export interface RemotePolicyGate {
  resolutionId: string;
  policy: PolicyDecision;
  attempt: number;
  approvalId: string | null;
}

export async function remotePolicyGate(
  core: Core,
  input: { caseId: string; runId: string; proposal: Pick<ResolutionProposal, 'actions' | 'rationale'>; diagnosisConfidence: number },
): Promise<RemotePolicyGate> {
  const { resolution, approvalId } = await core.resolutions.proposeFromAgent(
    input.caseId,
    input.runId,
    { actions: input.proposal.actions, rationale: input.proposal.rationale },
    { diagnosisConfidence: input.diagnosisConfidence, groundingViolations: 0 },
  );
  return { resolutionId: resolution.id, policy: resolution.policy, attempt: resolution.attempt, approvalId };
}

export type RemoteExecuteOutcome =
  | { outcome: 'OK'; steps: ExecutionStep[] }
  | { outcome: 'FAILED'; steps: ExecutionStep[] }
  | { outcome: 'ERROR'; message: string };

/** The `execute` node's body: run the actions, and close the run out when execution fails. */
export async function remoteExecute(core: Core, input: { caseId: string; runId: string; resolutionId: string }): Promise<RemoteExecuteOutcome> {
  const write = agentWriteContext(input.caseId, input.runId);
  try {
    const { execution } = await core.resolutions.execute(input.resolutionId, write);
    if (!execution.ok) {
      await core.resolutions.closeExecutionFailed(input.resolutionId, execution, write, { onFailure: 'ESCALATE' });
      return { outcome: 'FAILED', steps: execution.steps };
    }
    return { outcome: 'OK', steps: execution.steps };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await core.resolutions.escalateExecutionError(input.resolutionId, message, write);
    return { outcome: 'ERROR', message };
  }
}

export async function remoteValidate(core: Core, resolutionId: string): Promise<{ verdict: ValidationVerdict; checks: ValidationCheck[] }> {
  const result = await core.resolutions.validate(resolutionId);
  return { verdict: result.verdict, checks: result.checks };
}

export async function remoteCloseValidated(core: Core, input: { caseId: string; runId: string; resolutionId: string; verdict: ValidationVerdict }): Promise<void> {
  await core.resolutions.closeValidated(input.resolutionId, input.verdict, agentWriteContext(input.caseId, input.runId), { onFailure: 'ESCALATE' });
}

export async function remoteEscalateWithoutProposal(core: Core, input: { caseId: string; runId: string; reason: string }): Promise<void> {
  await core.resolutions.escalateWithoutProposal(input.caseId, input.reason, agentWriteContext(input.caseId, input.runId));
}

/** One `agent_steps` row plus its realtime event (the same sink the TypeScript graph uses). */
export async function remoteRecordStep(core: Core, input: { runId: string; caseId: string; node: string; kind: Parameters<ReturnType<typeof createEventSink>>[1]; payload: Record<string, unknown> }): Promise<void> {
  await createEventSink(core, input.runId, input.caseId)(input.node, input.kind, input.payload);
}

/** Copies the graph's final (or paused) state onto the run row and the evidence and findings tables. */
export async function remoteSyncRun(core: Core, input: { runId: string; caseId: string; state: Partial<PayOpsStateType>; interrupted: boolean }): Promise<void> {
  await syncRunRow(core, input.runId, input.caseId, input.state, input.interrupted);
}

export async function remoteFailRun(core: Core, runId: string, error: string): Promise<void> {
  const patch: RunPatch = { status: 'FAILED' as RunStatus, error, finishedAt: core.clock.now() };
  await patchRunRow(core, runId, patch);
}
