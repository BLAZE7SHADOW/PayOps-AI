import { choice, noul, score } from '@typesafe-ai/sdk';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionTag } from '@payops/shared';

export { choice, noul, score };
export type { Questions, SystemOneResult };

/** Text, a JSON object or array, or null. Matches the SDK's own `state` type exactly. */
export type JsonValue = EntryType;

export interface DecisionRequest<Q extends Questions> {
  state: JsonValue;
  questions: Q;
  tag: DecisionTag;
}

/**
 * Jev (TypeSafe "System One"), docs/03-agent-system.md §4. Every decision point calls `ask`
 * with a narrow, typed question set; the caller always has a deterministic fallback for when
 * this throws (timeout, error, or REPLAY miss).
 */
export interface DecisionPort {
  ask<Q extends Questions>(req: DecisionRequest<Q>): Promise<SystemOneResult<Q>>;
}
