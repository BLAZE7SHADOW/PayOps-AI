/**
 * Drives every golden scenario (golden.ts) end to end against a fresh ephemeral PGlite database
 * — same shape as `packages/agents/src/graph.test.ts` and `scripts/record-cassettes.ts`, just
 * generalized over a scenario list instead of one-off test bodies. Always REPLAY: cassette
 * scenarios replay real recorded model responses, fixture scenarios use the deterministic
 * `fixtures.ts` ports. Zero network either way (docs/03 §17 "`pnpm eval` runs in REPLAY (CI)").
 */
import { Command, isInterrupted } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  createCore,
  createDecisionPort,
  createLlmPort,
  loadServerEnv,
  tables,
  type Core,
} from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { newId, type ActionType } from '@payops/shared';
import { buildGraph, createEventSink, createRunRow } from '@payops/agents';
// Tooling-only import, same as packages/agents/scripts/record-cassettes.ts and graph.test.ts:
// production code never imports the simulator.
import { generateScenario } from '../../simulator/src/index';
import { fixtureDecisionPort, fixtureLlmPort } from './fixtures';
import { GOLDEN_SCENARIOS, type GoldenScenario } from './golden';
import type { RunOutcome } from './types';

const REPLAY_ENV = {
  AI_MODE: 'REPLAY' as const,
  AI_MODEL: 'unused',
  JEV_MODEL: 'unused',
  GEMINI_API_KEY: undefined,
  TYPESAFE_JEV_API_KEY: undefined,
};

export type EvalMode = 'REPLAY' | 'LIVE';

/**
 * LIVE only ever changes the driver for `{ kind: 'cassette' }` golden scenarios (real Gemini/Jev
 * calls, no cassette lookup) — the `{ kind: 'fixture' }` scenarios (replan loop, duplicate
 * capture, injection) are deterministic pipeline/safety proofs by design (docs/DECISIONS.md
 * D047-style), not a model-accuracy measurement, so they stay on the synthetic fixture in both
 * modes. `pnpm eval:live` therefore reports real model behavior for the 3 recorded scenarios and
 * real (code-only) pipeline behavior for the rest, never fabricated LIVE numbers.
 */
function cassetteEnv(mode: EvalMode) {
  if (mode === 'REPLAY') return REPLAY_ENV;
  const env = loadServerEnv({ AI_MODE: 'LIVE' });
  if (!env.GEMINI_API_KEY || !env.TYPESAFE_JEV_API_KEY) {
    throw new Error(
      'AI_MODE=LIVE eval needs GEMINI_API_KEY and TYPESAFE_JEV_API_KEY in .env (see docs/PROGRESS.md Blockers: this cloud session cannot reach either API — run pnpm eval:live from a machine with real network access to both).',
    );
  }
  return env;
}

/** Backs the one J1 (signal intake) call every golden scenario's case creation can trigger —
 * shared across all scenarios in one eval run. Only `injected_refund_request`'s note answers
 * non-zero; every other scenario's notes (if any) answer 0 (not injected), matching production
 * J1 behavior for ordinary support text. */
function sharedCoreDecision() {
  return fixtureDecisionPort({
    rootCause: 'UNKNOWN', // unused: core's decision port is only ever asked J1_INTAKE
    injectionByNoteText: (text) =>
      text.includes('SYSTEM NOTICE') && text.includes('refund') ? 0.97 : 0,
  });
}

async function runOne(
  core: Core,
  saver: PostgresSaver,
  db: TestDatabase,
  golden: GoldenScenario,
  mode: EvalMode,
): Promise<RunOutcome> {
  const t0 = Date.now();
  const failures: string[] = [];
  const generated = await generateScenario(core, { scenario: golden.scenario, seed: golden.seed });
  const caseId = generated.casesOpened[0]?.id;
  if (!caseId) {
    return {
      key: golden.key,
      scenario: golden.scenario,
      ok: false,
      failures: ['detection opened no case for this scenario/seed'],
      status: 'FAILED',
      tier: null,
      verdict: null,
      rootCause: null,
      expectedRootCause: golden.expectedRootCause,
      rootCauseMatch: false,
      knownRootCauseCaveat: golden.knownRootCauseCaveat,
      actionTypes: [],
      actionSetMatch: null,
      attempt: 0,
      replanned: false,
      toolCalls: 0,
      llmCalls: 0,
      jevCalls: 0,
      costUsd: 0,
      latencyMs: Date.now() - t0,
      groundingViolations: null,
      quarantineOk: null,
    };
  }

  const runId = newId('run');
  const cassetteKey = golden.driver.kind === 'cassette' ? golden.scenario : undefined;
  await createRunRow(core, { id: runId, caseId, scenarioKey: cassetteKey });
  const env = golden.driver.kind === 'cassette' ? cassetteEnv(mode) : null;
  const llm = env ? createLlmPort(env, golden.scenario) : fixtureLlmPort();
  const decision =
    golden.driver.kind === 'cassette'
      ? createDecisionPort(env!, golden.scenario)
      : fixtureDecisionPort(golden.driver.options);
  const deps = { core, llm, decision, onEvent: createEventSink(core, runId, caseId) };
  const config = { configurable: { thread_id: runId } };
  let result = await buildGraph(deps, saver).invoke(
    {
      caseId,
      runId,
      aiMode:
        mode === 'LIVE' && golden.driver.kind === 'cassette'
          ? ('LIVE' as const)
          : ('REPLAY' as const),
      scenarioKey: cassetteKey,
    },
    config,
  );

  if (isInterrupted(result)) {
    if (golden.onApproval === 'none') {
      failures.push(`unexpected approval interrupt at tier ${result.policy?.tier ?? 'unknown'}`);
    } else {
      const decisionType = golden.onApproval === 'approve' ? 'APPROVE' : 'REJECT';
      const manager = {
        id: `usr_eval_${golden.key}`,
        name: 'Eval manager',
        email: `eval-${golden.key}@payops.dev`,
        role: 'MANAGER' as const,
      };
      await db.db
        .insert(tables.users)
        .values({ ...manager, passwordHash: 'unused' })
        .onConflictDoNothing();
      await core.approvals.decide(
        result.approvalId!,
        { decision: decisionType, comment: golden.onApproval === 'reject' ? 'Eval rejection' : '' },
        manager,
      );
      result = await buildGraph(
        deps,
        new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' }),
      ).invoke(
        new Command({
          resume: {
            approvalId: result.approvalId,
            decision: decisionType,
            decidedBy: null,
            comment: golden.onApproval === 'reject' ? 'Eval rejection' : null,
          },
        }),
        config,
      );
    }
  } else if (golden.onApproval !== 'none') {
    failures.push(
      `expected an approval interrupt (onApproval="${golden.onApproval}") but the run never paused`,
    );
  }

  const latencyMs = Date.now() - t0;

  if (result.status !== golden.expect.status)
    failures.push(`status: expected ${golden.expect.status}, got ${result.status}`);
  const verdict = result.validation?.verdict ?? null;
  if (verdict !== golden.expect.verdict)
    failures.push(`verdict: expected ${golden.expect.verdict ?? 'null'}, got ${verdict ?? 'null'}`);
  const tier = result.policy?.tier ?? null;
  if (golden.expect.tier && tier !== golden.expect.tier)
    failures.push(`tier: expected ${golden.expect.tier}, got ${tier ?? 'null'}`);

  const actionTypes = (result.proposal?.actions ?? []).map((a: { type: ActionType }) => a.type);
  if (golden.forbiddenActionTypes) {
    const found = actionTypes.filter((t) => golden.forbiddenActionTypes!.includes(t));
    if (found.length > 0) failures.push(`forbidden action(s) proposed: ${found.join(', ')}`);
  }
  if (golden.maxToolCalls != null && result.budget.toolCalls > golden.maxToolCalls) {
    failures.push(`toolCalls ${result.budget.toolCalls} exceeds max ${golden.maxToolCalls}`);
  }

  // When a gate failed, say what the agent actually concluded so the report explains the miss.
  if (failures.length > 0) {
    const narrative = result.diagnosis?.narrative;
    if (narrative) failures.push(`agent diagnosis: ${narrative}`);
    if (result.error) failures.push(`run error: ${result.error}`);
  }

  let quarantineOk: boolean | null = null;
  if (golden.expectQuarantinedNoteIncluding) {
    const detail = await core.cases.get(caseId);
    const note = detail.notes.find((n) => n.text.includes(golden.expectQuarantinedNoteIncluding!));
    quarantineOk = !!note?.quarantined;
    if (!note)
      failures.push(
        `expected a note containing "${golden.expectQuarantinedNoteIncluding}", found none`,
      );
    else if (!note.quarantined)
      failures.push('expected the matching note to be quarantined by J1, it was not');
  }

  const rootCause = result.diagnosis?.rootCause ?? null;
  const rootCauseMatch = rootCause === golden.expectedRootCause;

  let actionSetMatch: boolean | null = null;
  if (golden.allowedActionSets) {
    actionSetMatch = golden.allowedActionSets.some(
      (set) => set.length === actionTypes.length && set.every((t, i) => t === actionTypes[i]),
    );
  }

  return {
    key: golden.key,
    scenario: golden.scenario,
    ok: failures.length === 0,
    failures,
    status: result.status,
    tier,
    verdict,
    rootCause,
    expectedRootCause: golden.expectedRootCause,
    rootCauseMatch,
    knownRootCauseCaveat: golden.knownRootCauseCaveat,
    actionTypes,
    actionSetMatch,
    attempt: result.attempt,
    replanned: (result.history?.length ?? 0) > 0,
    toolCalls: result.budget.toolCalls,
    llmCalls: result.budget.llmCalls,
    jevCalls: result.budget.jevCalls,
    costUsd: result.budget.costUsd,
    latencyMs,
    groundingViolations: result.grounding ? result.grounding.violations.length : null,
    quarantineOk,
  };
}

export interface EvalRunResult {
  outcomes: RunOutcome[];
}

/** Runs every golden scenario sequentially (they share one ephemeral database and checkpointer,
 * same as every other multi-scenario test/script in this repo — no reason to parallelize a
 * REPLAY run that's already sub-minute end to end) and returns their outcomes. Closes its own
 * database before returning. */
export async function runEvalSuite(
  scenarios: readonly GoldenScenario[] = GOLDEN_SCENARIOS,
  mode: EvalMode = 'REPLAY',
): Promise<EvalRunResult> {
  const db = await startTestDatabase();
  try {
    const core = createCore({
      db: db.db,
      clock: fixedClock('2026-09-28T12:00:00Z'),
      agentResumer: { resume: async () => {} },
      decision: sharedCoreDecision(),
    });
    const saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
    await saver.setup();

    const outcomes: RunOutcome[] = [];
    for (const golden of scenarios) {
      outcomes.push(await runOne(core, saver, db, golden, mode));
    }
    return { outcomes };
  } finally {
    await db.close();
  }
}
