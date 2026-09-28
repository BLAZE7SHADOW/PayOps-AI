import type { z } from 'zod';

/** One message in a chat-style prompt. Kept provider-agnostic; adapters translate. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCallMeta {
  /** Graph node making the call, e.g. "investigate" or "resolve". */
  node: string;
  /** Position of this call within the node, for cassette keys (docs/03 §14). */
  callIndex: number;
  /** Recorded cassette to read from / write to in RECORD/REPLAY. */
  scenarioKey?: string;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

/**
 * All LLM calls go through this port (docs/02 §3, docs/03 §14). Output is always structured:
 * the adapter is responsible for enforcing `schema` (e.g. via `withStructuredOutput`).
 */
export interface LlmPort {
  invokeStructured<T>(schema: z.ZodType<T>, messages: LlmMessage[], meta: LlmCallMeta): Promise<LlmResult<T>>;
}
