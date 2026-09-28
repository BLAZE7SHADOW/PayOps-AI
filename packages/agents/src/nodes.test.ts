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
import type { CaseBrief, EvidenceItem } from '@payops/shared';
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
    expect(update.budget?.llmCalls).toBeUndefined();
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
