/**
 * Deterministic, network-free `DecisionPort`/`LlmPort` fixtures for the eval runner's
 * `driver: 'fixture'` golden scenarios (see golden.ts). Mirrors the `decision()` fixture
 * `packages/agents/src/graph.test.ts` already uses for the fast path and the replan loop
 * (docs/DECISIONS.md D047) — same shape, generalized here to also answer J1_INTAKE (signal
 * intake, docs/03 §4 "J1") so the injection scenario can exercise quarantine end to end.
 *
 * Only used for scenarios that don't have a real recorded cassette (fixtures/cassettes/*.jsonl).
 * A cassette-backed scenario uses `createLlmPort`/`createDecisionPort` from `@payops/core`
 * instead (see runner.ts) — real recorded model behavior, still zero network in REPLAY.
 */
import type { DecisionPort, LlmPort } from '@payops/core';
import type { ReplanStrategy, RootCause } from '@payops/shared';

export interface FixtureOptions {
  /** J6's `root_cause` answer (docs/03 §4 "J6"). Drives the fast-path template. */
  rootCause: RootCause;
  /** J6's `evidence_consistent` Noul. Default 0.99 (clearly fast). */
  consistent?: number;
  /** J5's `strategy` answer when a replan is needed. Default `escalate_to_human`. */
  replanStrategy?: ReplanStrategy;
  /**
   * J1's `injection` Noul per note text (keyed by the note's own text so different notes in the
   * same case can answer differently). Any text not listed here answers 0 (not injected).
   * `injected_refund_request`'s golden scenario sets this so the note used to build the
   * quarantine assertion actually gets quarantined by decision, not just by the scenario's own
   * intent — the point of the eval is to prove the real J1 pipeline drops it.
   */
  injectionByNoteText?: (text: string) => number;
}

const noLlmPort: LlmPort = {
  invokeStructured: async () => {
    throw new Error(
      'Eval fixture: unexpected LLM call. This golden scenario is declared driver:"fixture" ' +
        '(fast-path only, docs/DECISIONS.md D047-style); if it now takes the full path (plan → ' +
        'specialists), it needs a real LlmPort mock or should move to a cassette-backed driver.',
    );
  },
};

/** Builds the deterministic DecisionPort used by both case creation (J1) and the agent run
 * (J2/J5/J6 — J3/J4 are not answered here since no fixture golden scenario takes the full path
 * today; a future full-path fixture scenario should extend this rather than silently guessing). */
export function fixtureDecisionPort(opts: FixtureOptions): DecisionPort {
  return {
    ask: (async (req: { tag: string; state: unknown; questions: Record<string, unknown> }) => {
      if (req.tag === 'J1_INTAKE') {
        const text = (req.state as { untrusted_text?: string } | null)?.untrusted_text ?? '';
        const injection = opts.injectionByNoteText?.(text) ?? 0;
        return {
          answers: {
            complaint_type: { choice: 'other', confidence: 0.9 },
            urgency: { noul: 0, confidence: 0.9 },
            injection: { noul: injection, confidence: 0.9 },
          },
          usage: { input_tokens: 8, output_tokens: 3 },
        };
      }
      if (req.tag === 'J5_REPLAN') {
        return {
          answers: {
            strategy: { choice: opts.replanStrategy ?? 'escalate_to_human', confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 3 },
        };
      }
      // J6_DIAGNOSE (and J2_PLAN's shape happens to be unreachable from a fast-path scenario,
      // since a confident J6 answer never routes into `plan` — see nodes.ts `diagnose`).
      return {
        answers: {
          root_cause: { choice: opts.rootCause, confidence: 0.99 },
          evidence_consistent: { noul: opts.consistent ?? 0.99, confidence: 0.99 },
          needs_human: { noul: 0, confidence: 0.99 },
        },
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    }) as unknown as DecisionPort['ask'],
  };
}

/** Every fixture golden scenario today resolves on the fast path (docs/03 §4a), which never
 * calls the LLM (`diagnose` short-circuits before `plan`/specialists/`resolve`'s LLM call). A
 * fixture scenario that reaches the full path throws loudly instead of silently returning junk
 * — see `noLlmPort` above. */
export function fixtureLlmPort(): LlmPort {
  return noLlmPort;
}
