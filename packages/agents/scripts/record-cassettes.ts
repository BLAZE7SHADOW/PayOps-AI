/**
 * Phase 4 task 9 (docs/06-phases.md): records real Gemini + Jev responses for the three Phase 3
 * demo scenarios into fixtures/cassettes/<scenarioKey>.jsonl, so `AI_MODE=REPLAY` (tests, the
 * public demo) can replay them deterministically with zero live calls. Only model responses are
 * recorded (docs/03 §14) -- the graph, tools, database, policy, executor and validator all run
 * for real against a fresh ephemeral PGlite database, exactly like `graph.test.ts`'s "recorded
 * Phase 3 scenarios" suite, just with real `AI_MODE=RECORD` ports instead of mocked REPLAY ones.
 *
 * Run: `corepack pnpm exec tsx packages/agents/scripts/record-cassettes.ts` from the repo root.
 * Requires GEMINI_API_KEY and TYPESAFE_JEV_API_KEY in .env (never printed; loaded the same way
 * `pnpm jev:ping` does, through `loadServerEnv`). Makes real, billed API calls.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  cassettePath,
  createCore,
  createDecisionPort,
  createLlmPort,
  loadServerEnv,
  tables,
  type Core,
} from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { newId, type RootCause, type ScenarioKey } from '@payops/shared';
// Scenario writers are test/tooling fixtures here; production code never imports the simulator
// (same rule graph.test.ts documents at its own import of this module).
import { generateScenario } from '../../simulator/src/index';
import { buildGraph } from '../src/graph';
import { createEventSink, createRunRow } from '../src/store';

const SCENARIOS: { scenario: ScenarioKey; seed: number; expectRootCause: RootCause }[] = [
  { scenario: 'captured_order_failed', seed: 3201, expectRootCause: 'WEBHOOK_PROCESSING_FAILURE' },
  { scenario: 'refund_stuck', seed: 3202, expectRootCause: 'REFUND_STATUS_NOT_SYNCED' },
  { scenario: 'refund_never_initiated', seed: 3203, expectRootCause: 'REFUND_NOT_INITIATED' },
];

async function recordOne(core: Core, saver: PostgresSaver, db: Awaited<ReturnType<typeof startTestDatabase>>, env: ReturnType<typeof loadServerEnv>, spec: (typeof SCENARIOS)[number]) {
  const { scenario, seed } = spec;
  const path = cassettePath(scenario);
  if (existsSync(path)) unlinkSync(path); // clean slate: appendCassette only ever appends

  console.warn(`\n=== ${scenario} (seed ${seed}) ===`);
  const generated = await generateScenario(core, { scenario, seed });
  const caseId = generated.casesOpened[0]!.id;
  const runId = newId('run');
  await createRunRow(core, { id: runId, caseId, scenarioKey: scenario });
  const deps = {
    core,
    llm: createLlmPort(env, scenario),
    decision: createDecisionPort(env, scenario),
    onEvent: createEventSink(core, runId, caseId),
  };
  const config = { configurable: { thread_id: runId } };
  const graph = buildGraph(deps, saver);
  let result = await graph.invoke({ caseId, runId, aiMode: 'RECORD' as const, scenarioKey: scenario }, config);

  if (scenario === 'refund_never_initiated') {
    console.warn(`  status=${result.status} tier=${result.policy?.tier} (expect AWAITING_APPROVAL / MANAGER)`);
    const manager = { id: 'usr_record_manager', name: 'Recording manager', email: 'record@payops.dev', role: 'MANAGER' as const };
    await db.db.insert(tables.users).values({ ...manager, passwordHash: 'unused' }).onConflictDoNothing();
    await core.approvals.decide(result.approvalId!, { decision: 'APPROVE', comment: '' }, manager);
    result = await buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' })).invoke(
      new Command({ resume: { approvalId: result.approvalId, decision: 'APPROVE', decidedBy: null, comment: null } }),
      config,
    );
  }

  console.warn(`  status=${result.status} tier=${result.policy?.tier} verdict=${result.validation?.verdict} rootCause=${result.diagnosis?.rootCause} path=${result.diagnosis?.path}`);
  if (result.status !== 'RESOLVED' || result.validation?.verdict !== 'PASS') {
    throw new Error(`${scenario}: expected RESOLVED/PASS, got status=${result.status} verdict=${result.validation?.verdict}`);
  }
  if (result.diagnosis?.rootCause !== spec.expectRootCause) {
    console.warn(`  NOTE: model diagnosis (${result.diagnosis?.rootCause}) differs from the expected root cause (${spec.expectRootCause}) -- same caveat fixtures/cassettes/README.md already documents for refund_stuck in the Phase 3 recording; grounding (task 6) checks citations, not causal correctness.`);
  }
  console.warn(`  wrote ${path}`);
}

async function main() {
  const env = loadServerEnv({ AI_MODE: 'RECORD' });
  if (!env.GEMINI_API_KEY || !env.TYPESAFE_JEV_API_KEY) {
    console.error('GEMINI_API_KEY and TYPESAFE_JEV_API_KEY must both be set in .env to record cassettes.');
    process.exitCode = 1;
    return;
  }
  console.warn(`Recording with AI_MODEL=${env.AI_MODEL} JEV_MODEL=${env.JEV_MODEL} (AI_MODE forced to RECORD)`);

  const db = await startTestDatabase();
  try {
    const core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z'), agentResumer: { resume: async () => {} } });
    const saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
    await saver.setup();

    for (const spec of SCENARIOS) {
      await recordOne(core, saver, db, env, spec);
    }
    console.warn('\nAll 3 scenarios recorded. Next: run `pnpm test` and confirm the graph.test.ts '
      + '"recorded Phase 3 scenarios" tests pass once un-skipped, then update fixtures/cassettes/README.md.');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('record-cassettes failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
