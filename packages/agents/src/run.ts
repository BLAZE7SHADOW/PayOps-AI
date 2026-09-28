/**
 * Entry points used by apps/server's pg-boss jobs (docs/02-architecture.md §4.2): start a fresh
 * run, or resume one paused at `awaitApproval` after a human decided. The checkpointer is a
 * module-level singleton (one Postgres connection pool for LangGraph's own `checkpoints` schema,
 * reused across jobs in this process — docs/02 §1 "one process").
 */
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Command, isInterrupted } from '@langchain/langgraph';
import { createDecisionPort, createLlmPort, type Core, type ServerEnv } from '@payops/core';
import { AGENT_BUDGET_LIMITS, newId, type ActorRef } from '@payops/shared';
import { buildGraph } from './graph';
import type { AgentDeps } from './deps';
import { createEventSink, createRunRow, getRunRow, patchRunRow, syncEvidenceAndFindings } from './store';
import type { PayOpsStateType } from './state';

export type AgentEnv = Pick<ServerEnv, 'AI_MODE' | 'AI_MODEL' | 'GEMINI_API_KEY' | 'JEV_MODEL' | 'TYPESAFE_JEV_API_KEY' | 'DATABASE_URL'>;

// Reuse the app pool: PGlite requires one connection across graph, jobs, and domain queries.
const checkpointers = new WeakMap<Core['db'], Promise<PostgresSaver>>();
async function getCheckpointer(core: Core): Promise<PostgresSaver> {
  let pending = checkpointers.get(core.db);
  if (!pending) {
    pending = (async () => {
      const saver = new PostgresSaver(core.db.$client, undefined, { schema: 'checkpoints' });
      await saver.setup();
      return saver;
    })();
    checkpointers.set(core.db, pending);
    pending.catch(() => checkpointers.delete(core.db));
  }
  return pending;
}

function buildDeps(core: Core, env: AgentEnv, runId: string, caseId: string, scenarioKey?: string): AgentDeps {
  return {
    core,
    llm: createLlmPort(env, scenarioKey),
    decision: createDecisionPort(env, scenarioKey),
    onEvent: createEventSink(core, runId, caseId),
  };
}

/** Copies the graph's terminal (or interrupted) state onto the persisted `agent_runs` row, and
 * fans the same evidence/findings out into the normalized `agent_findings`/`evidence` tables
 * (task 7, docs/04-data-model.md; D042). Both writes use the identical final `state` this call
 * already has -- there is no second read of the graph -- so the two never disagree within one
 * sync, only possibly across an interrupted/resumed run's separate syncs (each idempotent, see
 * `syncEvidenceAndFindings`'s doc comment in store.ts). */
async function syncRunRow(core: Core, runId: string, caseId: string, state: Partial<PayOpsStateType>, interrupted: boolean): Promise<void> {
  await patchRunRow(core, runId, {
    status: state.status,
    path: state.diagnosis?.path ?? null,
    resolutionId: state.resolutionId ?? null,
    approvalId: state.approvalId ?? null,
    attempt: state.attempt,
    budget: state.budget,
    evidence: state.evidence,
    findings: state.findings,
    diagnosis: state.diagnosis ?? null,
    proposal: state.proposal ?? null,
    policy: state.policy ?? null,
    finishedAt: interrupted ? null : core.clock.now(),
  });
  await syncEvidenceAndFindings(core, runId, caseId, {
    evidence: state.evidence ?? [],
    findings: state.findings ?? [],
    grounding: state.grounding ?? null,
  });
}

/** Called synchronously by the route: creates the row so `{runId}` can be returned in the 202. */
export async function createAgentRun(core: Core, caseId: string, scenarioKey?: string): Promise<{ runId: string }> {
  const runId = newId('run');
  await createRunRow(core, { id: runId, caseId, scenarioKey });
  return { runId };
}

/** Called from the `agent-run` pg-boss job: builds this run's ports and invokes the graph. */
export async function investigateAgentRun(core: Core, env: AgentEnv, runId: string, caseId: string, scenarioKey?: string): Promise<void> {
  const deps = buildDeps(core, env, runId, caseId, scenarioKey);
  const checkpointer = await getCheckpointer(core);
  const graph = buildGraph(deps, checkpointer);
  const config = { configurable: { thread_id: runId }, recursionLimit: AGENT_BUDGET_LIMITS.recursionLimit };

  try {
    const result = await graph.invoke({ caseId, runId, aiMode: env.AI_MODE, scenarioKey }, config);
    await syncRunRow(core, runId, caseId, result as Partial<PayOpsStateType>, isInterrupted(result));
  } catch (err) {
    await patchRunRow(core, runId, { status: 'FAILED', error: err instanceof Error ? err.message : String(err), finishedAt: core.clock.now() });
    throw err;
  }
}

export interface ResumeDecision {
  approvalId: string | null;
  decision: 'APPROVE' | 'REJECT' | 'ESCALATE';
  decidedBy?: ActorRef | null;
  comment?: string | null;
}

export async function resumeAgentRun(core: Core, env: AgentEnv, runId: string, decisionInput: ResumeDecision): Promise<void> {
  const row = await getRunRow(core, runId);
  if (!row) throw new Error(`agent run ${runId} not found`);
  const deps = buildDeps(core, env, runId, row.caseId, row.scenarioKey ?? undefined);
  const checkpointer = await getCheckpointer(core);
  const graph = buildGraph(deps, checkpointer);
  const config = { configurable: { thread_id: runId }, recursionLimit: AGENT_BUDGET_LIMITS.recursionLimit };

  try {
    const result = await graph.invoke(
      new Command({
        resume: {
          approvalId: decisionInput.approvalId,
          decision: decisionInput.decision,
          decidedBy: decisionInput.decidedBy ?? null,
          comment: decisionInput.comment ?? null,
        },
      }),
      config,
    );
    await syncRunRow(core, runId, row.caseId, result as Partial<PayOpsStateType>, isInterrupted(result));
  } catch (err) {
    await patchRunRow(core, runId, { status: 'FAILED', error: err instanceof Error ? err.message : String(err), finishedAt: core.clock.now() });
    throw err;
  }
}
