/**
 * Runs an agent investigation (docs/02-architecture.md §4.2). Two jobs: `agent-run` starts a
 * fresh graph invocation; `agent-resume` continues one paused at `awaitApproval` after a human
 * decision. Both jobs just call into `@payops/agents`; nothing about the graph lives here.
 */
import type { PgBoss } from 'pg-boss';
import { getRunRow, investigateAgentRun, resumeAgentRun, type AgentEnv, type ResumeDecision } from '@payops/agents';
import type { Core, Logger, ServerEnv } from '@payops/core';
import { QUEUES } from './boss';

export interface AgentRunJobPayload {
  runId: string;
  caseId: string;
  scenarioKey?: string;
}

export interface AgentResumeJobPayload {
  runId: string;
  decision: ResumeDecision;
}

function agentEnv(env: ServerEnv): AgentEnv {
  return {
    AI_MODE: env.AI_MODE,
    AI_MODEL: env.AI_MODEL,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    JEV_MODEL: env.JEV_MODEL,
    TYPESAFE_JEV_API_KEY: env.TYPESAFE_JEV_API_KEY,
    DATABASE_URL: env.DATABASE_URL,
  };
}

/** Calls the Python agent service (D085) and waits for the run to finish or pause for approval. */
async function callPythonAgent(env: ServerEnv, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${env.AGENT_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-secret': env.AGENT_INTERNAL_SECRET ?? '' },
    body: JSON.stringify(body),
    // A cold Render service takes about a minute to wake, and a LIVE run can take a few more.
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`agent service ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export async function registerAgentJobs(boss: PgBoss, core: Core, env: ServerEnv, log: Logger): Promise<void> {
  const aiEnv = agentEnv(env);
  const python = env.AGENT_RUNTIME === 'python';
  if (python && !env.AGENT_INTERNAL_SECRET) throw new Error('AGENT_RUNTIME=python needs AGENT_INTERNAL_SECRET (D085)');

  const polling = { pollingIntervalSeconds: env.JOB_POLL_SECONDS };

  await boss.work<AgentRunJobPayload>(QUEUES.agentRun, polling, async ([job]) => {
    if (!job) return;
    const { runId, caseId, scenarioKey } = job.data;
    log.info({ runId, caseId, runtime: env.AGENT_RUNTIME }, 'agent run starting');
    if (python) await callPythonAgent(env, '/runs', { runId, caseId, scenarioKey, aiMode: env.AI_MODE });
    else await investigateAgentRun(core, aiEnv, runId, caseId, scenarioKey);
    log.info({ runId }, 'agent run job done');
  });

  await boss.work<AgentResumeJobPayload>(QUEUES.agentResume, polling, async ([job]) => {
    if (!job) return;
    const { runId, decision } = job.data;
    log.info({ runId, decision: decision.decision, runtime: env.AGENT_RUNTIME }, 'agent run resuming');
    if (python) {
      const row = await getRunRow(core, runId);
      if (!row) throw new Error(`agent run ${runId} not found`);
      await callPythonAgent(env, `/runs/${runId}/resume`, { caseId: row.caseId, scenarioKey: row.scenarioKey ?? undefined, aiMode: env.AI_MODE, decision });
    } else await resumeAgentRun(core, aiEnv, runId, decision);
    log.info({ runId }, 'agent resume job done');
  });

  log.info('agent jobs registered');
}
