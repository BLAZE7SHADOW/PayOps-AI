export * from './jev-decision.adapter';
export * from './recording-decision.adapter';
export * from './replay-decision.adapter';

import type { ServerEnv } from '../../config/env';
import type { DecisionPort } from '../../ports/decision';
import { JevDecisionAdapter } from './jev-decision.adapter';
import { RecordingDecisionAdapter } from './recording-decision.adapter';
import { ReplayDecisionAdapter } from './replay-decision.adapter';

export type DecisionEnv = Pick<ServerEnv, 'AI_MODE' | 'JEV_MODEL' | 'TYPESAFE_JEV_API_KEY'>;

/** Builds the DecisionPort for one agent run. See createLlmPort for the scenario-key fallback. */
export function createDecisionPort(env: DecisionEnv, scenarioKey?: string): DecisionPort {
  const key = scenarioKey ?? 'default';
  if (env.AI_MODE === 'REPLAY') return new ReplayDecisionAdapter(key);
  if (!env.TYPESAFE_JEV_API_KEY) throw new Error(`TYPESAFE_JEV_API_KEY is required for AI_MODE=${env.AI_MODE}`);
  const live = new JevDecisionAdapter({ apiKey: env.TYPESAFE_JEV_API_KEY, model: env.JEV_MODEL });
  return env.AI_MODE === 'RECORD' ? new RecordingDecisionAdapter(live, key) : live;
}
