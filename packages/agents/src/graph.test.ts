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

  it('catches a wrong root-cause label the fix would not have exposed (P1 task 1, D057 gap)', async () => {
    // The evidence shows one failed webhook and one capture. Jev claims DUPLICATE_CAPTURE, which
    // the evidence cannot support, so the cause is downgraded and the case is not auto-fixed.
    const { result } = await run('captured_order_failed', 'DUPLICATE_CAPTURE', 703);
    expect(result.diagnosis?.rootCause).toBe('UNKNOWN');
    expect(result.diagnosis?.narrative).toMatch(/DUPLICATE_CAPTURE was not confirmed/);
    expect(result.proposal?.actions.map((a) => a.type)).toEqual(['ESCALATE_TO_HUMAN']);
    expect(result.status).not.toBe('RESOLVED');
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


describe('budget guard (docs/06-phases.md Phase 5 task 5, docs/DECISIONS.md D049)', () => {
  it('escalates cleanly with no resolution when a single call\'s estimated cost alone exceeds MAX_COST_USD', async () => {
    // A real J6_DIAGNOSE answer, but with an absurd token count -- enough on its own (via
    // estimateCallCostUsd) to exceed AGENT_BUDGET_LIMITS.maxCostUsd before `plan` or `resolve`
    // ever run. `diagnose` is the very first Jev/LLM call on the graph, so this proves the guard
    // fires as early as the very first checkpoint, not just after many rounds.
    const hugeCostDecision: DecisionPort = {
      ask: vi.fn(async () => ({
        answers: {
          root_cause: { choice: 'WEBHOOK_PROCESSING_FAILURE', confidence: 0.99 },
          evidence_consistent: { noul: 0.99, confidence: 0.99 },
          needs_human: { noul: 0, confidence: 0.99 },
        },
        usage: { input_tokens: 5_000_000, output_tokens: 1_000_000 },
      })) as unknown as DecisionPort['ask'],
    };
    const generated = await generateScenario(core, { scenario: 'captured_order_failed', seed: 704 });
    const caseId = generated.casesOpened[0]!.id;
    const runId = newId('run');
    await createRunRow(core, { id: runId, caseId });
    const deps = { core, llm: noLlm, decision: hugeCostDecision, onEvent: createEventSink(core, runId, caseId) };
    const graph = buildGraph(deps, saver);
    const result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY' }, { configurable: { thread_id: runId } });

    expect(result.status).toBe('ESCALATED');
    expect(result.resolutionId).toBeNull();
    expect(result.error).toContain('Budget guard');
    expect(result.error).toContain('cost an estimated');
    expect(result.budget.jevCalls).toBe(1); // the guard stops the run after the call that tripped it, not before

    // No resolution ever existed -- only the case itself moved to ESCALATED
    // (`resolution.service.ts`'s `escalateWithoutProposal`, not `closeValidated`).
    const detail = await core.cases.get(caseId);
    expect(detail.status).toBe('ESCALATED');
    expect(detail.resolutionView.pendingApprovalId ?? null).toBeNull();
  });
});

describe('failure drills (docs/06-phases.md Phase 5 task 6): each ends in a defined state, never an uncaught rejection', () => {
  /** A `DecisionPort` that answers every Jev tag the full path can reach (J2/J3/J4/J6) with a
   * real, valid shape -- unlike the top-of-file `decision()` fixture (fast-path/replan only), so
   * this drill can isolate "Gemini fails" from "Jev also happens to fail on a shape mismatch".
   * J6 deliberately answers with low `evidence_consistent` so `diagnose` always takes the full
   * path (`resolve` needs the LLM), regardless of which root cause a given scenario expects. */
  function fullPathDecision(): DecisionPort {
    return {
      ask: vi.fn(async (req: { tag: string }) => {
        switch (req.tag) {
          case 'J6_DIAGNOSE':
            return {
              answers: {
                root_cause: { choice: 'UNKNOWN', confidence: 0.99 },
                evidence_consistent: { noul: 0, confidence: 0.9 },
                needs_human: { noul: 0, confidence: 0.9 },
              },
              usage: { input_tokens: 10, output_tokens: 3 },
            };
          case 'J2_PLAN':
            return {
              answers: {
                primary_hypothesis: { choice: 'settlement_reconciliation', confidence: 0.9 },
                need_payment: { noul: 1, confidence: 0.9 },
                need_reconciliation: { noul: 1, confidence: 0.9 },
                need_risk: { noul: 0, confidence: 0.9 },
              },
              usage: { input_tokens: 10, output_tokens: 3 },
            };
          case 'J3_RISK':
            return {
              answers: {
                velocity_abuse: { score: 0, confidence: 0.95 },
                identity_mismatch: { score: 0, confidence: 0.95 },
                chargeback_pattern: { score: 0, confidence: 0.95 },
                merchant_exposure: { score: 0, confidence: 0.95 },
              },
              usage: { input_tokens: 10, output_tokens: 3 },
            };
          case 'J4_GROUND':
            return { answers: { sufficient: { type: 'noul', noul: 1, confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 3 } };
          default:
            throw new Error(`fullPathDecision fixture: unexpected Jev tag ${req.tag}`);
        }
      }) as unknown as DecisionPort['ask'],
    };
  }

  it('Gemini timeout: a specialist LLM call throwing contributes nothing (never crashes); resolve\'s own diagnosis call throwing escalates cleanly with no resolution', async () => {
    // settlement_mismatch always takes the full path (docs/PROGRESS.md: its FINDING template
    // never yields citable ids on the fast path), so `resolve` is guaranteed to need the LLM.
    // Jev (`fullPathDecision` above) answers every tag normally -- only Gemini is down here.
    const generated = await generateScenario(core, { scenario: 'settlement_mismatch', seed: 5001 });
    const caseId = generated.casesOpened[0]!.id;
    const runId = newId('run');
    await createRunRow(core, { id: runId, caseId, scenarioKey: 'settlement_mismatch' });
    const deps = { core, llm: noLlm, decision: fullPathDecision(), onEvent: createEventSink(core, runId, caseId) };
    const graph = buildGraph(deps, saver);
    const result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY', scenarioKey: 'settlement_mismatch' }, { configurable: { thread_id: runId } });

    expect(result.status).toBe('ESCALATED');
    expect(result.resolutionId).toBeNull(); // never reached policyGate -- resolve failed before proposing anything
    expect(result.error).toContain('Gemini call failed');
    // Both specialists ran and contributed nothing (their own LLM calls threw and were caught),
    // not zero agents visited -- `plan`'s J2 answer above routes both in.
    expect(result.agentsVisited).toEqual(expect.arrayContaining(['payment', 'reconciliation']));
    expect(result.findings).toHaveLength(0);

    const detail = await core.cases.get(caseId);
    expect(detail.status).toBe('ESCALATED');
    expect(detail.resolutionView.pendingApprovalId ?? null).toBeNull();
  });

  it('Jev timeout: every Jev call throwing throughout a full run still resolves cleanly via each decision point\'s own documented fallback', async () => {
    // diagnose (J6) throws -> forced FULL path; plan (J2) throws -> DEFAULT_ALL (every
    // specialist runs); riskAgent (J3) throws -> rules-only tier, no LLM; groundCheck (J4) throws
    // -> structural-only check. None of that stops the run: Gemini is healthy here (the mirror
    // image of the drill above), so the full path still investigates and resolves normally --
    // this is the "defined state" for a persistent Jev outage: the product keeps working, per
    // CLAUDE.md's "the product must work with AI turned off".
    const alwaysThrowsDecision: DecisionPort = { ask: vi.fn(async () => { throw new Error('Jev unreachable (simulated persistent timeout)'); }) as unknown as DecisionPort['ask'] };
    const fullPathLlm: LlmPort = {
      invokeStructured: vi.fn(async (_schema: unknown, _messages: unknown, meta: { node: string; callIndex: number }) => {
        if (meta.node === 'resolve') {
          return { data: { rootCause: 'WEBHOOK_PROCESSING_FAILURE', narrative: 'Diagnosed via Gemini while Jev was unreachable throughout the run.', confidence: 0.9, supportingFindingIds: [] }, usage: { inputTokens: 50, outputTokens: 20 } };
        }
        if (meta.callIndex === 0) return { data: { followUps: [] }, usage: { inputTokens: 20, outputTokens: 5 } };
        return { data: { findings: [{ code: 'OTHER' as const, statement: 'Specialist finding produced while Jev was unreachable.', evidenceIds: ['ev_placeholder'], confidence: 0.6 }] }, usage: { inputTokens: 30, outputTokens: 10 } };
      }) as unknown as LlmPort['invokeStructured'],
    };
    const generated = await generateScenario(core, { scenario: 'captured_order_failed', seed: 5002 });
    const caseId = generated.casesOpened[0]!.id;
    const runId = newId('run');
    await createRunRow(core, { id: runId, caseId });
    const deps = { core, llm: fullPathLlm, decision: alwaysThrowsDecision, onEvent: createEventSink(core, runId, caseId) };
    const graph = buildGraph(deps, saver);
    const result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY' }, { configurable: { thread_id: runId } });

    expect(result.status).toBe('RESOLVED');
    expect(result.validation?.verdict).toBe('PASS');
    expect(result.diagnosis?.path).toBe('FULL'); // J6 throwing always forces the full path
    const detail = await core.cases.get(caseId);
    expect(detail.status).toBe('RESOLVED');
  });

  it('database serialization conflict during execute: core.resolutions.execute throwing after the executor\'s own retries are exhausted escalates the existing resolution instead of crashing the run', async () => {
    // `packages/core/src/db/retry.test.ts` already covers `withSerializationRetry` retrying and
    // eventually giving up on a persistent 40001 in isolation. Reproducing a genuine Postgres
    // serialization conflict here would need real concurrent SERIALIZABLE transactions racing
    // each other -- slow and inherently flaky. Spying on `core.resolutions.execute` to reject
    // once, the same way, tests exactly the part this drill is actually about: what the graph
    // does once that call is exhausted and still fails.
    const generated = await generateScenario(core, { scenario: 'captured_order_failed', seed: 5004 });
    const caseId = generated.casesOpened[0]!.id;
    const runId = newId('run');
    await createRunRow(core, { id: runId, caseId });
    const deps = { core, llm: noLlm, decision: decision('WEBHOOK_PROCESSING_FAILURE'), onEvent: createEventSink(core, runId, caseId) };
    const graph = buildGraph(deps, saver);

    const serializationError = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
    const executeSpy = vi.spyOn(core.resolutions, 'execute').mockRejectedValueOnce(serializationError);
    let result;
    try {
      result = await graph.invoke({ caseId, runId, aiMode: 'REPLAY' }, { configurable: { thread_id: runId } });
    } finally {
      executeSpy.mockRestore();
    }

    expect(result.status).toBe('ESCALATED');
    expect(result.error).toContain('could not serialize access');
    expect(result.resolutionId).not.toBeNull(); // policyGate did create a resolution before execute failed

    const detail = await core.cases.get(caseId);
    expect(detail.status).toBe('ESCALATED');
    expect(detail.resolutionView.pendingApprovalId ?? null).toBeNull();
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

describe('recorded critical showcase cases', () => {
  it.each([
    ['showcase_webhook_recovery', 3301, 'WEBHOOK_PROCESSING_FAILURE', 'AUTO'],
    ['showcase_duplicate_capture', 3302, 'DUPLICATE_CAPTURE', 'MANAGER'],
    ['showcase_settlement_dispute', 3304, 'SETTLEMENT_FEE_MISMATCH', 'OPS'],
    ['showcase_ledger_gap', 3306, 'LEDGER_POSTING_MISSING', 'AUTO'],
  ] as const)('%s resolves with the recorded diagnosis, policy and validator', async (scenario, seed, rootCause, tier) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider network is forbidden in REPLAY'));
    try {
      const generated = await generateScenario(core, { scenario, seed });
      const caseId = generated.casesOpened[0]!.id;
      expect((await core.cases.get(caseId)).severity).toBe('CRITICAL');
      const runId = newId('run');
      await createRunRow(core, { id: runId, caseId, scenarioKey: scenario });
      const env = { AI_MODE: 'REPLAY' as const, AI_MODEL: 'unused', JEV_MODEL: 'unused', GEMINI_API_KEY: undefined, TYPESAFE_JEV_API_KEY: undefined };
      const deps = { core, llm: createLlmPort(env, scenario), decision: createDecisionPort(env, scenario), onEvent: createEventSink(core, runId, caseId) };
      const config = { configurable: { thread_id: runId } };
      let result = await buildGraph(deps, saver).invoke({ caseId, runId, aiMode: 'REPLAY', scenarioKey: scenario }, config);
      expect(result.policy?.tier).toBe(tier);
      if (result.status === 'AWAITING_APPROVAL') {
        const manager = { id: 'usr_showcase_manager', name: 'Showcase manager', email: 'showcase@payops.dev', role: 'MANAGER' as const };
        await db.db.insert(tables.users).values({ ...manager, passwordHash: 'unused' }).onConflictDoNothing();
        await core.approvals.decide(result.approvalId!, { decision: 'APPROVE', comment: '' }, manager);
        result = await buildGraph(deps, new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' })).invoke(new Command({ resume: { approvalId: result.approvalId, decision: 'APPROVE', decidedBy: null, comment: null } }), config);
      }
      expect(result.diagnosis?.rootCause).toBe(rootCause);
      expect(result.diagnosis?.path).toBe('FULL');
      expect(result.agentsVisited.length).toBeGreaterThanOrEqual(2);
      expect(result.status).toBe('RESOLVED');
      expect(result.validation?.verdict).toBe('PASS');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
