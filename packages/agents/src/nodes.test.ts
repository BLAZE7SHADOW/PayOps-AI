/**
 * Node-level tests for `riskAgent` (docs/03-agent-system.md §4 "J3"), isolated from the graph
 * and the database: all four risk tools are baseline, so `riskAgent` never calls `loadCaseState`
 * itself (nodes.ts) — it only reads `state.evidence`, `decision` and, on low confidence, `llm`.
 * That makes a fake `DecisionPort`/`LlmPort` enough to exercise its three branches: a confident
 * Jev read, a low-confidence Jev read that falls through to one LLM findings call, and Jev
 * throwing into the J3 rules-only fallback (docs/03 §4 "Jev adapter contract").
 */
import { describe, expect, it, vi } from 'vitest';
import type { Core, DecisionPort, LlmPort } from '@payops/core';
import type { CaseBrief, EvidenceItem, Finding, InvestigationPlan } from '@payops/shared';
import { buildNodes } from './nodes';
import type { PayOpsStateType } from './state';

const brief: CaseBrief = {
  caseId: 'case_a',
  displayId: 'PAY-0001',
  type: 'SUSPICIOUS_PAYMENT',
  detectionRuleIds: ['D8_RISK_VELOCITY'],
  amountBand: 'HIGH',
  mismatchedSystems: [],
  flags: { hasRefund: false, hasSettlementBatch: false, isDuplicate: false, quarantinedText: false },
};

const riskEvidence: EvidenceItem[] = [
  { id: 'ev_01', source: 'getCustomerHistory', system: 'RISK', entityRef: 'cus_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { accountAgeDays: 400, riskFlagsCount: 0, riskFlags: 'none' } },
  { id: 'ev_02', source: 'getDeviceSignals', system: 'RISK', entityRef: 'cus_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { deviceCount: 1, cardCountriesDistinct: 1, primaryIpCountry: 'IN', ipCardCountryMismatch: false } },
  { id: 'ev_03', source: 'getFailedAttempts', system: 'RISK', entityRef: 'cus_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { failed24h: 0, total24h: 1 } },
  { id: 'ev_04', source: 'getChargebackHistory', system: 'RISK', entityRef: 'mer_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { merchantDisputeCount: 0, note: 'proxy' } },
];

/** Only the fields `riskAgent` actually reads (nodes.ts): it never touches the database, so a
 * minimal state is enough — no full `PayOpsState` default is needed. */
function baseState(evidence: EvidenceItem[]): PayOpsStateType {
  return { caseId: 'case_a', runId: 'run_a', aiMode: 'REPLAY', case: brief, evidence, findings: [] } as unknown as PayOpsStateType;
}

const noopEvent = vi.fn(async () => {});
const failingLlm: LlmPort = { invokeStructured: vi.fn(async () => { throw new Error('Unexpected LLM call'); }) };

function confidentDecision(): DecisionPort {
  const answer = (score: number) => ({ score, confidence: 0.95, legend: {}, probabilities: {}, type: 'score' as const });
  return {
    ask: vi.fn(async () => ({
      answers: { velocity_abuse: answer(0), identity_mismatch: answer(0), chargeback_pattern: answer(0), merchant_exposure: answer(0) },
      usage: { input_tokens: 20, output_tokens: 8 },
    })) as unknown as DecisionPort['ask'],
  };
}

function unsureDecision(): DecisionPort {
  const answer = (score: number) => ({ score, confidence: 0.2, legend: {}, probabilities: {}, type: 'score' as const });
  return {
    ask: vi.fn(async () => ({
      answers: { velocity_abuse: answer(2), identity_mismatch: answer(1), chargeback_pattern: answer(0), merchant_exposure: answer(0) },
      usage: { input_tokens: 20, output_tokens: 8 },
    })) as unknown as DecisionPort['ask'],
  };
}

const throwingDecision: DecisionPort = { ask: vi.fn(async () => { throw new Error('Jev timed out'); }) as unknown as DecisionPort['ask'] };

describe('riskAgent (docs/03 §4 "J3", §5 node table)', () => {
  it('produces a LOW-tier RiskAssessment with no LLM call when Jev is confident', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: confidentDecision(), onEvent: noopEvent });
    const update = await nodes.riskAgent(baseState(riskEvidence)) as Partial<PayOpsStateType>;
    expect(update.risk).toMatchObject({ tier: 'LOW' });
    expect(update.risk?.meanConfidence).toBeCloseTo(0.95);
    expect(update.findings).toBeUndefined();
    expect(update.budget?.jevCalls).toBe(1);
    expect(update.budget?.llmCalls).toBe(0);
  });

  it('falls through to one LLM findings call when Jev\'s mean confidence is under 0.5', async () => {
    const llm: LlmPort = {
      invokeStructured: vi.fn(async () => ({
        data: { findings: [{ code: 'RISK_SIGNAL', statement: 'Velocity looks abnormal [ev_03].', evidenceIds: ['ev_03'], confidence: 0.6 }] },
        usage: { inputTokens: 100, outputTokens: 40 },
      })) as unknown as LlmPort['invokeStructured'],
    };
    const nodes = buildNodes({ core: {} as Core, llm, decision: unsureDecision(), onEvent: noopEvent });
    const update = await nodes.riskAgent(baseState(riskEvidence)) as Partial<PayOpsStateType>;
    expect(update.risk?.meanConfidence).toBeLessThan(0.5);
    expect(update.findings).toHaveLength(1);
    expect(update.findings?.[0]).toMatchObject({ agent: 'risk', evidenceIds: ['ev_03'] });
    expect(update.budget?.llmCalls).toBe(1);
    expect(llm.invokeStructured).toHaveBeenCalledTimes(1);
  });

  it('drops a low-confidence LLM finding that cites no risk evidence (structural grounding)', async () => {
    const llm: LlmPort = {
      invokeStructured: vi.fn(async () => ({
        data: { findings: [{ code: 'RISK_SIGNAL', statement: 'Unsupported claim.', evidenceIds: ['ev_99'], confidence: 0.4 }] },
        usage: { inputTokens: 100, outputTokens: 40 },
      })) as unknown as LlmPort['invokeStructured'],
    };
    const nodes = buildNodes({ core: {} as Core, llm, decision: unsureDecision(), onEvent: noopEvent });
    const update = await nodes.riskAgent(baseState(riskEvidence)) as Partial<PayOpsStateType>;
    expect(update.findings).toHaveLength(0);
  });

  it('falls back to a rules-only tier and never crashes the graph when Jev throws (J3 fallback)', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: throwingDecision, onEvent: noopEvent });
    const update = await nodes.riskAgent(baseState(riskEvidence)) as Partial<PayOpsStateType>;
    expect(update.risk).toBeDefined();
    expect(update.risk?.tier).toBe('LOW'); // clean signals in `riskEvidence` above
    expect(update.risk?.meanConfidence).toBe(0); // marks this as a fallback assessment
    expect(update.findings).toBeUndefined(); // fallback never calls the LLM
    expect(update.budget?.jevCalls).toBe(1);
  });

  it('contributes nothing and does not call Jev when there is no risk evidence at all', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: throwingDecision, onEvent: noopEvent });
    const update = await nodes.riskAgent(baseState([])) as Partial<PayOpsStateType>;
    expect(update.risk).toBeUndefined();
    expect(update.agentsVisited).toEqual(['risk']);
  });
});

/**
 * Node-level tests for `groundCheck` (docs/03 §4 "J4", §5, Phase 4 task 6) and the `plan` node's
 * gap-targeted re-round branch. `groundCheck` never calls `loadCaseState` (nodes.ts) -- it only
 * reads `state.findings`/`state.evidence`/`state.agentsVisited`/`state.investigationRound` and
 * `decision` -- so, like `riskAgent` above, a fake `DecisionPort` is enough.
 */
const groundingEvidence: EvidenceItem[] = [
  { id: 'ev_01', source: 'getWebhookDeliveries', system: 'WEBHOOK', entityRef: 'wh_1', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { finalStatus: 'FAILED', lastHttpStatus: 500, event: 'payment.captured', attempts: 1 } },
  { id: 'ev_02', source: 'getCustomerHistory', system: 'RISK', entityRef: 'cus_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { accountAgeDays: 1 } },
];
const soundFinding: Finding = { id: 'fd_01', agent: 'payment', code: 'WEBHOOK_HTTP_500', statement: 'The webhook failed with HTTP 500 [ev_01].', evidenceIds: ['ev_01'], confidence: 0.9 };
// Structurally corrupted: cites real evidence, but the wrong kind for its own code (WEBHOOK_HTTP_500
// needs a cited WEBHOOK item with lastHttpStatus >= 500; ev_02 is RISK evidence).
const corruptedFinding: Finding = { id: 'fd_02', agent: 'risk', code: 'WEBHOOK_HTTP_500', statement: 'CORRUPTED_UNSUPPORTED_CLAIM [ev_02].', evidenceIds: ['ev_02'], confidence: 0.9 };

function groundState(partial: Partial<PayOpsStateType>): PayOpsStateType {
  return { caseId: 'case_a', runId: 'run_a', aiMode: 'REPLAY', evidence: groundingEvidence, findings: [soundFinding], agentsVisited: ['payment'], investigationRound: 1, ...partial } as unknown as PayOpsStateType;
}

function groundDecision(supportByFindingId: Record<string, 'supported' | 'contradicted' | 'not_enough_evidence'>, sufficientNoul: number): DecisionPort {
  return {
    ask: vi.fn(async (req: { questions: Record<string, unknown> }) => {
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(req.questions)) {
        if (key === 'sufficient') { answers[key] = { type: 'noul', noul: sufficientNoul, confidence: 0.9 }; continue; }
        const findingId = key.replace(/^support_/, '');
        answers[key] = { type: 'choice', choice: supportByFindingId[findingId] ?? 'not_enough_evidence', confidence: 0.9 };
      }
      return { answers, usage: { input_tokens: 15, output_tokens: 5 } };
    }) as unknown as DecisionPort['ask'],
  };
}

describe('groundCheck (docs/03 §4 "J4", §7, Phase 4 task 6)', () => {
  it('drops a structurally corrupted finding before Jev ever sees it, and never asks Jev about it', async () => {
    const decision = groundDecision({ fd_01: 'supported' }, 0.9);
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision, onEvent: noopEvent });
    const update = await nodes.groundCheck(groundState({ findings: [soundFinding, corruptedFinding] })) as Partial<PayOpsStateType>;
    expect(update.grounding?.violations).toEqual([{ findingId: 'fd_02', reason: 'cited evidence does not satisfy the WEBHOOK_HTTP_500 predicate' }]);
    const asked = (decision.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { questions: Record<string, unknown> };
    expect(Object.keys(asked.questions)).toEqual(['support_fd_01', 'sufficient']); // fd_02 was already gone
  });

  it('drops a finding Jev marks contradicted at confidence >= 0.5, recording a GroundingViolation (never reaches resolve)', async () => {
    const decision = groundDecision({ fd_01: 'contradicted' }, 0.9);
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision, onEvent: noopEvent });
    const update = await nodes.groundCheck(groundState({})) as Partial<PayOpsStateType>;
    expect(update.grounding?.violations).toEqual([{ findingId: 'fd_01', reason: 'Jev J4 marked this claim contradicted by its cited evidence' }]);
    expect(update.grounding?.needsHumanReview).toBe(false);
  });

  it('sets gaps for the agents that lost their findings when insufficient and the round budget allows it', async () => {
    const decision = groundDecision({ fd_01: 'contradicted' }, 0.2);
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision, onEvent: noopEvent });
    const update = await nodes.groundCheck(groundState({ investigationRound: 1 })) as Partial<PayOpsStateType>;
    expect(update.grounding?.sufficient).toBe(false);
    expect(update.gaps).toEqual([{ agent: 'payment', reason: 'payment ran but has no findings that survived grounding' }]);
  });

  it('never adds gaps once the round budget is spent, even when still insufficient', async () => {
    const decision = groundDecision({ fd_01: 'contradicted' }, 0.1);
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision, onEvent: noopEvent });
    const update = await nodes.groundCheck(groundState({ investigationRound: 2 })) as Partial<PayOpsStateType>;
    expect(update.gaps).toEqual([]);
  });

  it('J4 fallback: structural check only, needsHumanReview set, and never takes an extra round from the error alone', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: throwingDecision, onEvent: noopEvent });
    const update = await nodes.groundCheck(groundState({ findings: [soundFinding, corruptedFinding], investigationRound: 1 })) as Partial<PayOpsStateType>;
    expect(update.grounding?.needsHumanReview).toBe(true);
    expect(update.grounding?.sufficient).toBe(true);
    expect(update.gaps).toEqual([]);
    // The structural pass still ran and still caught the corrupted finding, fallback or not.
    expect(update.grounding?.violations).toEqual([{ findingId: 'fd_02', reason: 'cited evidence does not satisfy the WEBHOOK_HTTP_500 predicate' }]);
  });
});

describe('plan: gap-targeted re-round (docs/03 §5 "groundCheck -> plan")', () => {
  it('routes only to the specialists named in `gaps`, skipping J2 entirely', async () => {
    const priorPlan: InvestigationPlan = { primaryHypothesis: 'webhook_or_state_sync', specialists: ['payment', 'reconciliation', 'risk'], routedBy: 'JEV', confidence: 0.9 };
    const neverCalled: DecisionPort = { ask: vi.fn(async () => { throw new Error('J2 should never be asked on a targeted re-round'); }) as unknown as DecisionPort['ask'] };
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: neverCalled, onEvent: noopEvent });
    const state = { caseId: 'case_a', runId: 'run_a', aiMode: 'REPLAY', case: brief, investigationPlan: priorPlan, gaps: [{ agent: 'payment', reason: 'payment ran but has no findings that survived grounding' }], investigationRound: 1 } as unknown as PayOpsStateType;
    const update = await nodes.plan(state) as Partial<PayOpsStateType>;
    expect(update.investigationPlan).toMatchObject({ specialists: ['payment'], routedBy: 'GAP_TARGETED' });
    expect(update.investigationRound).toBe(2);
    expect(neverCalled.ask).not.toHaveBeenCalled();
  });
});

describe('plan: fresh J2 routing and its fallback (docs/03 §4 "J2", "Jev adapter contract")', () => {
  const j2Decision = (): DecisionPort => ({
    ask: vi.fn(async () => ({
      answers: {
        primary_hypothesis: { type: 'choice', choice: 'webhook_or_state_sync', confidence: 0.9, probabilities: {} },
        need_payment: { type: 'noul', noul: 0.9 },
        need_reconciliation: { type: 'noul', noul: 0.1 },
        need_risk: { type: 'noul', noul: 0.1 },
      },
      usage: { input_tokens: 15, output_tokens: 6 },
    })) as unknown as DecisionPort['ask'],
  });
  const throwingDecision: DecisionPort = { ask: vi.fn(async () => { throw new Error('Jev timed out'); }) as unknown as DecisionPort['ask'] };

  function freshState(): PayOpsStateType {
    return { caseId: 'case_a', runId: 'run_a', aiMode: 'REPLAY', case: brief, gaps: [], investigationRound: 0 } as unknown as PayOpsStateType;
  }

  it('routes by J2 when Jev answers normally', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: j2Decision(), onEvent: noopEvent });
    const update = await nodes.plan(freshState()) as Partial<PayOpsStateType>;
    expect(update.investigationPlan).toMatchObject({ primaryHypothesis: 'webhook_or_state_sync', routedBy: 'JEV' });
    expect(update.investigationPlan?.specialists).toContain('payment');
    expect(update.investigationRound).toBe(1);
    expect(update.budget?.jevCalls).toBe(1);
  });

  it('falls back to running every specialist, never crashing the graph, when Jev throws (J2 fallback)', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: throwingDecision, onEvent: noopEvent });
    const update = await nodes.plan(freshState()) as Partial<PayOpsStateType>;
    expect(update.investigationPlan).toMatchObject({ routedBy: 'DEFAULT_ALL' });
    expect(update.investigationPlan?.specialists).toEqual(['payment', 'reconciliation', 'risk']);
    expect(update.investigationRound).toBe(1);
  });
});

describe('diagnose: J6 fast-path diagnosis and its fallback (docs/03 §4a "J6", "Jev adapter contract")', () => {
  const fastEvidence: EvidenceItem[] = [
    { id: 'ev_01', source: 'getWebhookDeliveries', system: 'WEBHOOK', entityRef: 'wh_a', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { finalStatus: 'FAILED', lastHttpStatus: 500 } },
  ];
  const confidentJ6 = (): DecisionPort => ({
    ask: vi.fn(async () => ({
      answers: {
        root_cause: { type: 'choice', choice: 'WEBHOOK_PROCESSING_FAILURE', confidence: 0.95, probabilities: {} },
        evidence_consistent: { type: 'noul', noul: 0.9 },
        needs_human: { type: 'noul', noul: 0.1 },
      },
      usage: { input_tokens: 12, output_tokens: 4 },
    })) as unknown as DecisionPort['ask'],
  });
  const throwingDecision: DecisionPort = { ask: vi.fn(async () => { throw new Error('Jev timed out'); }) as unknown as DecisionPort['ask'] };

  function state(evidence: EvidenceItem[]): PayOpsStateType {
    return { caseId: 'case_a', runId: 'run_a', aiMode: 'REPLAY', case: brief, evidence, findings: [] } as unknown as PayOpsStateType;
  }

  it('reaches the FAST path with no LLM call when Jev is confident and evidence supports the root cause', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: confidentJ6(), onEvent: noopEvent });
    const update = await nodes.diagnose(state(fastEvidence)) as Partial<PayOpsStateType>;
    expect(update.diagnosis).toMatchObject({ rootCause: 'WEBHOOK_PROCESSING_FAILURE', path: 'FAST' });
    expect(update.budget?.jevCalls).toBe(1);
  });

  it('falls back to the FULL path (diagnosis left null), never crashing the graph, when Jev throws (J6 fallback)', async () => {
    const nodes = buildNodes({ core: {} as Core, llm: failingLlm, decision: throwingDecision, onEvent: noopEvent });
    const update = await nodes.diagnose(state(fastEvidence)) as Partial<PayOpsStateType>;
    expect(update.diagnosis).toBeNull();
    expect(update.budget?.jevCalls).toBe(1);
  });
});
