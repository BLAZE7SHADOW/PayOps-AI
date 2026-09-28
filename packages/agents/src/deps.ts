/**
 * What the graph needs injected, built once per run by the caller (apps/server's pg-boss job).
 * `llm`/`decision` are per-run because REPLAY/RECORD pick their cassette file from the run's
 * `scenarioKey` (docs/03-agent-system.md §14).
 */
import type { Core, DecisionPort, LlmPort } from '@payops/core';
import type { AgentStepKind } from '@payops/shared';

export interface AgentEventPayload {
  [key: string]: unknown;
}

/** Persists one `agent_steps` row and forwards it as a realtime event (docs/03 §16). */
export type AgentEventSink = (node: string, kind: AgentStepKind, payload: AgentEventPayload) => Promise<void>;

export interface AgentDeps {
  core: Core;
  llm: LlmPort;
  decision: DecisionPort;
  onEvent: AgentEventSink;
}
