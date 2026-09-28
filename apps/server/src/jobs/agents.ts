/**
 * Runs an agent investigation (docs/02-architecture.md §4.2). Two jobs: `agent-run` starts a
 * fresh graph invocation; `agent-resume` continues one paused at `awaitApproval` after a human
 * decision. Both jobs just call into `@payops/agents`; nothing about the graph lives here.
 */
import type { PgBoss } from 'pg-boss';
import { investigateAgentRun, resumeAgentRun, type AgentEnv, type ResumeDecision } from '@payops/agents';
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

export async function registerAgentJobs(boss: PgBoss, core: Core, env: ServerEnv, log: Logger): Promise<void> {
  const aiEnv = agentEnv(env);

  await boss.work<AgentRunJobPayload>(QUEUES.agentRun, async ([job]) => {
    if (!job) return;
    const { runId, caseId, scenarioKey } = job.data;
    log.info({ runId, caseId }, 'agent run starting');
    await investigateAgentRun(core, aiEnv, runId, caseId, scenarioKey);
    log.info({ runId }, 'agent run job done');
  });

  await boss.work<AgentResumeJobPayload>(QUEUES.agentResume, async ([job]) => {
    if (!job) return;
    const { runId, decision } = job.data;
    log.info({ runId, decision: decision.decision }, 'agent run resuming');
    await resumeAgentRun(core, aiEnv, runId, decision);
    log.info({ runId }, 'agent resume job done');
  });

  log.info('agent jobs registered');
}
