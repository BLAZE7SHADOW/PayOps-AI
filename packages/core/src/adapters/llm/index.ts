export * from './gemini-llm.adapter';
export * from './recording-llm.adapter';
export * from './replay-llm.adapter';

import type { ServerEnv } from '../../config/env';
import type { LlmPort } from '../../ports/llm';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
import { RecordingLlmAdapter } from './recording-llm.adapter';
import { ReplayLlmAdapter } from './replay-llm.adapter';
import type { ProviderRetrySink } from '../provider-retry';

export type LlmEnv = Pick<ServerEnv, 'AI_MODE' | 'AI_MODEL' | 'GEMINI_API_KEY'>;

/**
 * Builds the LlmPort for one agent run (docs/03 §14). REPLAY/RECORD need a scenario key to pick
 * the cassette file; when one isn't given (an organic run outside the seeded demo data) it falls
 * back to `"default"`, and a REPLAY run with no matching cassette fails loudly (ReplayMissError).
 */
export function createLlmPort(env: LlmEnv, scenarioKey?: string, onRetry?: ProviderRetrySink): LlmPort {
  const key = scenarioKey ?? 'default';
  if (env.AI_MODE === 'REPLAY') return new ReplayLlmAdapter(key);
  if (!env.GEMINI_API_KEY) throw new Error(`GEMINI_API_KEY is required for AI_MODE=${env.AI_MODE}`);
  const live = new GeminiLlmAdapter({ apiKey: env.GEMINI_API_KEY, model: env.AI_MODEL, onRetry });
  return env.AI_MODE === 'RECORD' ? new RecordingLlmAdapter(live, key) : live;
}
