import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createCore, createDecisionPort, createLlmPort, tables, type Core, type DecisionPort, type LlmPort } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { newId, type ReplanStrategy, type RootCause, type ScenarioKey } from '@payops/shared';
// Scenario writers are test fixtures here; the production agent never imports the simulator.
import { generateScenario } from '../../simulator/src/index';
import { buildGraph } from './graph';
import { createEventSink, createRunRow, listSteps } from './store';

let db: TestDatabase;
let core: Core;
let saver: PostgresSaver;
const noLlm: LlmPort = { invokeStructured: vi.fn(async () => { throw new Error('Unexpected LLM call'); }) };
/**
 * J6's diagnosis answer is fixed per test; J5's replan answer defaults to `escalate_to_human`
 * (matching every pre-Phase-5 test's expectation of "fails once, stops") unless a test asks for
 * a specific `replanStrategy` (docs/DECISIONS.md D047's `replay_fails_then_replan` scenario).
 */
const decision = (rootCause: RootCause, opts: { consistent?: number; replanStrategy?: ReplanStrategy } = {}): DecisionPort => ({
  ask: vi.fn(async (req: { tag: string }) => {
    if (req.tag === 'J5_REPLAN') {
      return {
        answers: { strategy: { choice: opts.replanStrategy ?? 'escalate_to_human', confidence: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    }
    return {
      answers: { root_cause: { choice: rootCause, confidence: 0.99 }, evidence_consistent: { noul: opts.consistent ?? 0.99, confidence: 0.99 }, needs_human: { noul: 0, confidence: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
  }) as unknown as DecisionPort['ask'],
});

beforeAll(async () => {
  db = await startTestDatabase();
  core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z'), agentResumer: { resume: async () => {} } });
  saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
  await saver.setup();
});
afterAll(async () => { await db?.close(); });

async function run(scenario: ScenarioKey, rootCause: RootCause, seed: number, replanStrategy?: ReplanStrategy) {
  const generated = await generateScenario(core, { scenario, seed });
  const caseId = generated.casesOpened[0]!.id;
  const runId = newId('run');
  await createRunRow(core, { id: runId, caseId });
  const deps = { core, llm: noLlm, decision: decision(rootCause, { replanStrategy }), onEvent: createEventSink(core, runId, caseId) };
  const config = { configurable: { thread_id: runId } };
  const graph = buildGraph(deps, saver);
  const result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY' }, config);
  return { result, deps, config, runId, caseId };
}

describe('Phase 3 graph with real Postgres checkpoints and deterministic services', () => {
  it('resolves a captured payment through AUTO and independently verifies PASS without Gemini', async () => {
    const { result } = await run('captured_order_failed', 'WEBHOOK_PROCESSING_FAILURE', 701);
    expect(result.status).toBe('RESOLVED');
    expect(result.policy?.tier).toBe('AUTO');
    expect(result.validation?.verdict).toBe('PASS');
    expect(result.budget.llmCalls).toBe(0);
    expect(result.budget.toolCalls).toBe(11); // triage now also runs the 4 baseline risk tools added in task 5
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.diagnosis?.supportingFindingIds).toEqual(result.findings.map((f) => f.id));
    expect(result.diagnosis?.narrative).toMatch(/\[ev_\d+\]/);
  });

  it('syncs a stuck refund with cited gateway evidence', async () => {
    const { result } = await run('refund_stuck', 'REFUND_STATUS_NOT_SYNCED', 702);
    expect(result.status).toBe('RESOLVED');
    expect(result.validation?.verdict).toBe('PASS');
    expect(result.diagnosis?.narrative).toMatch(/\[ev_\d+\]/);
  });

  it('pauses a large refund and resumes a newly constructed graph without re-running investigation', async () => {
    const { result, deps, config, runId } = await run('refund_never_initiated', 'REFUND_NOT_INITIATED', 703);
    expect(isInterrupted(result)).toBe(true);
    expect(result.policy?.tier).toBe('MANAGER');
    const before = await listSteps(core, runId);
    // Rejection exercises durable resume without bypassing the approval service for money movement.
    const restored = buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' }));
    const resumed = await restored.invoke(new Command({ resume: { approvalId: result.approvalId, decision: 'REJECT', decidedBy: null, comment: 'Test rejection' } }), config);
    expect(resumed.status).toBe('REJECTED');
    const after = await listSteps(core, runId);
    expect(after.filter((s) => s.node === 'triage')).toHaveLength(before.filter((s) => s.node === 'triage').length);
    expect(after.filter((s) => s.kind === 'PROPOSAL_CREATED')).toHaveLength(1);
  });

  it('escalates a failed execution when J5 says escalate_to_human', async () => {
    const { result } = await run('replay_fails_then_replan', 'WEBHOOK_PROCESSING_FAILURE', 704, 'escalate_to_human');
    expect(result.status).toBe('ESCALATED');
    expect(result.validation?.verdict).toBe('FAIL');
    expect(result.attempt).toBe(1);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ attempt: 1, verdict: 'FAIL' });
  });

  it('replans and resolves on attempt 2 (docs/03 §13)', async () => {
    // Attempt 1 proposes REPLAY_WEBHOOK_EVENT -> validator FAIL (order still FAILED at the
    // simulated version-conflict fault). J5 says alternative_action; `resolve` rebuilds the
    // proposal with attempt 1 in `history`, which `recommendedTypes` (core/actions/options.ts)
    // already turns into MARK_ORDER_PAID + POST_LEDGER_ENTRY once a replay has failed before ->
    // attempt 2 validates PASS. Exactly docs/03 §13's demo scenario. This action set carries a
    // higher policy tier than a plain replay, so attempt 2 pauses for approval first -- the same
    // `interrupt`/resume path the "pauses a large refund" test above already exercises.
    const run705 = await run('replay_fails_then_replan', 'WEBHOOK_PROCESSING_FAILURE', 705, 'alternative_action');
    const { deps, config } = run705;
    let result = run705.result;
    expect(result.attempt).toBe(2);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ attempt: 1, verdict: 'FAIL', actions: [{ type: 'REPLAY_WEBHOOK_EVENT' }] });
    expect(result.proposal?.actions.map((a: { type: string }) => a.type)).toEqual(['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY']);
    if (isInterrupted(result)) {
      const manager = { id: 'usr_replan_manager', name: 'Replan manager', email: 'replan@payops.dev', role: 'MANAGER' as const };
      await db.db.insert(tables.users).values({ ...manager, passwordHash: 'unused' }).onConflictDoNothing();
      await core.approvals.decide(result.approvalId!, { decision: 'APPROVE', comment: '' }, manager);
      result = await buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' })).invoke(new Command({ resume: { approvalId: result.approvalId, decision: 'APPROVE', decidedBy: null, comment: null } }), config);
    }
    expect(result.status).toBe('RESOLVED');
    expect(result.validation?.verdict).toBe('PASS');
  });

  it('asks J5 exactly once when attempt 2 already resolves', async () => {
    const { deps } = await run('replay_fails_then_replan', 'WEBHOOK_PROCESSING_FAILURE', 706, 'alternative_action');
    const j5Calls = (deps.decision.ask as unknown as { mock: { calls: [{ tag: string }][] } }).mock.calls.filter(([req]) => req.tag === 'J5_REPLAN');
    expect(j5Calls).toHaveLength(1);
  });
});


describe('recorded Phase 3 scenarios', () => {
  // Re-recorded for Phase 4 task 9 (docs/06-phases.md) against the current specialist-split
  // graph (`paymentAgent`/`reconciliationAgent`/`riskAgent`) and ContextBuilder prompts via
  // `pnpm cassette:record` (packages/agents/scripts/record-cassettes.ts, docs/DECISIONS.md D045).
  it.each(['captured_order_failed', 'refund_stuck', 'refund_never_initiated'] as const)('replays %s with no provider network calls', async (scenario) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider network is forbidden in REPLAY'));
    try {
      const generated = await generateScenario(core, { scenario, seed: { captured_order_failed: 3201, refund_stuck: 3202, refund_never_initiated: 3203 }[scenario] });
      const caseId = generated.casesOpened[0]!.id;
      const runId = newId('run');
      await createRunRow(core, { id: runId, caseId, scenarioKey: scenario });
      const env = { AI_MODE: 'REPLAY' as const, AI_MODEL: 'unused', JEV_MODEL: 'unused', GEMINI_API_KEY: undefined, TYPESAFE_JEV_API_KEY: undefined };
      const deps = { core, llm: createLlmPort(env, scenario), decision: createDecisionPort(env, scenario), onEvent: createEventSink(core, runId, caseId) };
      const graph = buildGraph(deps, saver);
      const config = { configurable: { thread_id: runId } };
      let result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY', scenarioKey: scenario }, config);
      if (scenario === 'refund_never_initiated') {
        expect(result.status).toBe('AWAITING_APPROVAL');
        expect(result.policy?.tier).toBe('MANAGER');
        const manager = { id: 'usr_replay_manager', name: 'Replay manager', email: 'replay@payops.dev', role: 'MANAGER' as const };
        await db.db.insert(tables.users).values({ ...manager, passwordHash: 'unused' }).onConflictDoNothing();
        await core.approvals.decide(result.approvalId!, { decision: 'APPROVE', comment: '' }, manager);
        result = await buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' })).invoke(new Command({ resume: { approvalId: result.approvalId, decision: 'APPROVE', decidedBy: null, comment: null } }), config);
      }
      expect(result.status).toBe('RESOLVED');
      expect(result.validation?.verdict).toBe('PASS');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
