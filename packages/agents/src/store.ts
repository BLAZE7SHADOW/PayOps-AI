/**
 * Persistence for `agent_runs` / `agent_steps` (docs/03-agent-system.md §6, §16). Kept as plain
 * Drizzle queries against core's schema rather than a core service, since only the graph writes
 * these tables; the read side (`GET /api/runs*`) lives in apps/server/src/routes/runs.ts using
 * the same tables.
 */
import { asc, count, eq } from 'drizzle-orm';
import { newId, ROOMS, RUN_EVENTS, type AgentStepKind, type RunEventEnvelope, type RunPath, type RunStatus } from '@payops/shared';
import { tables, type Core } from '@payops/core';
import type { AgentEventPayload, AgentEventSink } from './deps';

const { agentRuns, agentSteps } = tables;

export async function createRunRow(core: Core, input: { id: string; caseId: string; scenarioKey?: string }): Promise<void> {
  const now = core.clock.now();
  await core.db.insert(agentRuns).values({
    id: input.id,
    caseId: input.caseId,
    scenarioKey: input.scenarioKey ?? null,
    status: 'INVESTIGATING',
    path: null,
    attempt: 1,
    budget: { llmCalls: 0, jevCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    evidence: [],
    findings: [],
    diagnosis: null,
    proposal: null,
    policy: null,
    createdAt: now,
    updatedAt: now,
  });
}

export interface RunPatch {
  status?: RunStatus;
  path?: RunPath | null;
  resolutionId?: string | null;
  approvalId?: string | null;
  attempt?: number;
  scenarioKey?: string | null;
  budget?: { llmCalls: number; jevCalls: number; toolCalls: number; tokensIn: number; tokensOut: number; costUsd: number };
  evidence?: unknown;
  findings?: unknown;
  diagnosis?: unknown;
  proposal?: unknown;
  policy?: unknown;
  error?: string | null;
  finishedAt?: Date | null;
}

export async function patchRunRow(core: Core, runId: string, patch: RunPatch): Promise<void> {
  await core.db
    .update(agentRuns)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- state fields are already typed at the call site
    .set({ ...(patch as any), updatedAt: core.clock.now() })
    .where(eq(agentRuns.id, runId));
}

async function nextSeq(core: Core, runId: string): Promise<number> {
  const [row] = await core.db.select({ n: count() }).from(agentSteps).where(eq(agentSteps.runId, runId));
  return (row?.n ?? 0) + 1;
}

/** Builds the sink passed to the graph: persists one `agent_steps` row and publishes it live. */
export function createEventSink(core: Core, runId: string, caseId: string): AgentEventSink {
  return async (node, kind, payload) => {
    const seq = await nextSeq(core, runId);
    const at = core.clock.now();
    await core.db.insert(agentSteps).values({ id: newId('agentStep'), runId, seq, node, kind, payload, at });
    const eventName = RUN_EVENTS.find((e) => AGENT_STEP_EVENT[kind] === e) ?? 'node.completed';
    const envelope: RunEventEnvelope = { runId, caseId, node, at: at.toISOString(), seq, data: payload };
    core.events.publish(ROOMS.ops, eventName, envelope);
    core.events.publish(ROOMS.case(caseId), eventName, envelope);
  };
}

/** Maps our step kinds to the realtime event names in docs/03 §16. */
const AGENT_STEP_EVENT: Record<AgentStepKind, string> = {
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  TOOL_CALLED: 'tool.called',
  TOOL_COMPLETED: 'tool.completed',
  DECISION_MADE: 'decision.made',
  LLM_CALLED: 'node.completed',
  FINDING_CREATED: 'finding.created',
  PROPOSAL_CREATED: 'proposal.created',
  POLICY_DECIDED: 'policy.decided',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  EXECUTION_STEP: 'execution.step',
  VALIDATION_COMPLETED: 'validation.completed',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
};

export type { AgentEventPayload };

export async function listSteps(core: Core, runId: string) {
  return core.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.seq));
}

export async function getRunRow(core: Core, runId: string) {
  const [row] = await core.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ?? null;
}
