import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command, isInterrupted } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createCore, type Core, type DecisionPort, type LlmPort } from '@payops/core';
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
  core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z') });
  saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
  await saver.setup();
});
afterAll(async () => { await db.close(); });

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
