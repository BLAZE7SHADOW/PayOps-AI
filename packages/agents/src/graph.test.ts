import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createCore, createDecisionPort, createLlmPort, tables, type Core, type DecisionPort, type LlmPort } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { newId, type RootCause, type ScenarioKey } from '@payops/shared';
// Scenario writers are test fixtures here; the production agent never imports the simulator.
import { generateScenario } from '../../simulator/src/index';
import { buildGraph } from './graph';
import { createEventSink, createRunRow, listSteps } from './store';

let db: TestDatabase;
let core: Core;
let saver: PostgresSaver;
const noLlm: LlmPort = { invokeStructured: vi.fn(async () => { throw new Error('Unexpected LLM call'); }) };
const decision = (rootCause: RootCause, consistent = 0.99): DecisionPort => ({
  ask: vi.fn(async () => ({
    answers: { root_cause: { choice: rootCause, confidence: 0.99 }, evidence_consistent: { noul: consistent, confidence: 0.99 }, needs_human: { noul: 0, confidence: 0.99 } },
    usage: { input_tokens: 10, output_tokens: 3 },
  })) as unknown as DecisionPort['ask'],
});

beforeAll(async () => {
  db = await startTestDatabase();
  core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z'), agentResumer: { resume: async () => {} } });
  saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
  await saver.setup();
});
afterAll(async () => { await db?.close(); });

async function run(scenario: ScenarioKey, rootCause: RootCause, seed: number) {
  const generated = await generateScenario(core, { scenario, seed });
  const caseId = generated.casesOpened[0]!.id;
  const runId = newId('run');
  await createRunRow(core, { id: runId, caseId });
  const deps = { core, llm: noLlm, decision: decision(rootCause), onEvent: createEventSink(core, runId, caseId) };
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

  it('escalates a failed execution without replanning', async () => {
    const { result } = await run('replay_fails_then_replan', 'WEBHOOK_PROCESSING_FAILURE', 704);
    expect(result.status).toBe('ESCALATED');
    expect(result.validation?.verdict).toBe('FAIL');
    expect(result.attempt).toBe(1);
  });
});


describe('recorded Phase 3 scenarios', () => {
  // SKIPPED (docs/06-phases.md Phase 4 task 9 "Record cassettes for all scenarios", not done
  // yet): these fixtures were recorded against Phase 3's single `investigate` node. Tasks 3-6
  // changed node names (`investigate` -> `paymentAgent`/`reconciliationAgent`/`riskAgent`) and
  // task 4 rewrote every prompt's exact text (ContextBuilder). The cassette lookup key is a hash
  // of {node, callIndex, prompt}, so both changes miss every recorded entry (ReplayMissError).
  // Re-record with `AI_MODE=RECORD` + real API keys as task 9, then remove this skip.
  it.skip.each(['captured_order_failed', 'refund_stuck', 'refund_never_initiated'] as const)('replays %s with no provider network calls', async (scenario) => {
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
