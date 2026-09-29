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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  cassettePath,
  DEFAULT_CASSETTE_DIR,
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

interface Spec {
  scenario: ScenarioKey;
  seed: number;
  /** When set, a different diagnosis is only noted. When strict, the run must end RESOLVED/PASS. */
  expectRootCause?: RootCause;
  strict: boolean;
  strictDiagnosis?: boolean;
}

/**
 * Every fault scenario, two seeds each, so the hosted REPLAY demo has plenty to show. The first
 * three primary seeds (3201-3203) are the original Phase 4 recordings that graph.test.ts replays.
 * Other scenarios are recorded as they actually end (resolved, awaiting approval, escalated or
 * blocked) and that outcome goes into the manifest the Simulator page shows.
 */
const SCENARIOS: Spec[] = [
  { scenario: 'captured_order_failed', seed: 3201, expectRootCause: 'WEBHOOK_PROCESSING_FAILURE', strict: true },
  { scenario: 'refund_stuck', seed: 3202, expectRootCause: 'REFUND_STATUS_NOT_SYNCED', strict: true },
  { scenario: 'refund_never_initiated', seed: 3203, expectRootCause: 'REFUND_NOT_INITIATED', strict: true },
  { scenario: 'settlement_mismatch', seed: 3204, strict: false },
  { scenario: 'duplicate_capture', seed: 3205, strict: false },
  { scenario: 'suspicious_payment', seed: 3206, strict: false },
  { scenario: 'replay_fails_then_replan', seed: 3207, strict: false },
  { scenario: 'injected_refund_request', seed: 3208, strict: false },
  { scenario: 'captured_order_failed', seed: 3211, strict: false },
  { scenario: 'refund_stuck', seed: 3212, strict: false },
  { scenario: 'refund_never_initiated', seed: 3213, strict: false },
  { scenario: 'settlement_mismatch', seed: 3214, strict: false },
  { scenario: 'duplicate_capture', seed: 3215, strict: false },
  { scenario: 'suspicious_payment', seed: 3216, strict: false },
  { scenario: 'replay_fails_then_replan', seed: 3217, strict: false },
  { scenario: 'injected_refund_request', seed: 3218, strict: false },
  { scenario: 'showcase_webhook_recovery', seed: 3301, expectRootCause: 'WEBHOOK_PROCESSING_FAILURE', strict: true, strictDiagnosis: true },
  { scenario: 'showcase_duplicate_capture', seed: 3302, expectRootCause: 'DUPLICATE_CAPTURE', strict: true, strictDiagnosis: true },
  { scenario: 'showcase_settlement_dispute', seed: 3304, expectRootCause: 'SETTLEMENT_FEE_MISMATCH', strict: true, strictDiagnosis: true },
  { scenario: 'showcase_ledger_gap', seed: 3306, expectRootCause: 'LEDGER_POSTING_MISSING', strict: true, strictDiagnosis: true },
];

/** What the Simulator page shows for each recorded (scenario, seed). */
interface ManifestEntry {
  scenario: ScenarioKey;
  seed: number;
  status: string;
  tier: string | null;
  verdict: string | null;
  rootCause: string | null;
  recordedAt: string;
}
const MANIFEST_PATH = join(DEFAULT_CASSETTE_DIR, 'manifest.json');

function readManifest(): ManifestEntry[] {
  return existsSync(MANIFEST_PATH) ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestEntry[]) : [];
}
function upsertManifest(entry: ManifestEntry) {
  const rest = readManifest().filter((e) => !(e.scenario === entry.scenario && e.seed === entry.seed));
  const all = [...rest, entry].sort((a, b) => a.seed - b.seed);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

async function recordOne(core: Core, saver: PostgresSaver, db: Awaited<ReturnType<typeof startTestDatabase>>, env: ReturnType<typeof loadServerEnv>, spec: Spec, freshFile: boolean) {
  const { scenario, seed } = spec;
  const path = cassettePath(scenario);
  // appendCassette only ever appends, so a full re-record of a scenario starts from an empty file.
  if (freshFile && existsSync(path)) unlinkSync(path);

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

  // Approvals: a manager can approve any tier, so play that role until the run stops asking.
  for (let i = 0; i < 3 && result.status === 'AWAITING_APPROVAL' && result.approvalId; i++) {
    console.warn(`  status=${result.status} tier=${result.policy?.tier}; approving as manager`);
    const manager = { id: 'usr_record_manager', name: 'Recording manager', email: 'record@payops.dev', role: 'MANAGER' as const };
    await db.db.insert(tables.users).values({ ...manager, passwordHash: 'unused' }).onConflictDoNothing();
    await core.approvals.decide(result.approvalId, { decision: 'APPROVE', comment: '' }, manager);
    result = await buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' })).invoke(
      new Command({ resume: { approvalId: result.approvalId, decision: 'APPROVE', decidedBy: null, comment: null } }),
      config,
    );
  }

  console.warn(`  status=${result.status} tier=${result.policy?.tier} verdict=${result.validation?.verdict} rootCause=${result.diagnosis?.rootCause} path=${result.diagnosis?.path}`);
  if (spec.strict && (result.status !== 'RESOLVED' || result.validation?.verdict !== 'PASS')) {
    throw new Error(`${scenario}: expected RESOLVED/PASS, got status=${result.status} verdict=${result.validation?.verdict}`);
  }
  if (spec.expectRootCause && result.diagnosis?.rootCause !== spec.expectRootCause) {
    if (spec.strictDiagnosis) throw new Error(`${scenario}: expected root cause ${spec.expectRootCause}, got ${result.diagnosis?.rootCause}`);
    console.warn(`  NOTE: model diagnosis (${result.diagnosis?.rootCause}) differs from the expected root cause (${spec.expectRootCause}) -- same caveat fixtures/cassettes/README.md documents; grounding checks citations, not causal correctness.`);
  }
  upsertManifest({
    scenario,
    seed,
    status: String(result.status),
    tier: result.policy?.tier ?? null,
    verdict: result.validation?.verdict ?? null,
    rootCause: result.diagnosis?.rootCause ?? null,
    recordedAt: new Date().toISOString(),
  });
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

    // Usage: record-cassettes.ts [--all] [--only scenario,scenario]
    //   default : record only (scenario, seed) pairs missing from manifest.json, appending to cassettes
    //   --all   : re-record everything from scratch (deletes each scenario cassette first)
    //   --only  : limit to the named scenarios (still skips already-recorded pairs unless --all)
    const args = process.argv.slice(2);
    const all = args.includes('--all');
    const onlyArg = args[args.indexOf('--only') + 1];
    const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
    const done = new Set(readManifest().map((e) => `${e.scenario}:${e.seed}`));
    const seenFresh = new Set<string>();
    const todo = SCENARIOS.filter((s) => (!only || only.has(s.scenario)) && (all || !done.has(`${s.scenario}:${s.seed}`)));
    if (todo.length === 0) console.warn('Nothing to record: every scenario/seed is already in manifest.json (use --all to redo).');
    for (const spec of todo) {
      const first = all && !seenFresh.has(spec.scenario);
      seenFresh.add(spec.scenario);
      await recordOne(core, saver, db, env, spec, first);
    }
    console.warn(`\nRecorded ${todo.length} run(s). Next: run \`pnpm test\`, then commit fixtures/cassettes/.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('record-cassettes failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
