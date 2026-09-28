/**
 * Pure J4 grounding logic (docs/03-agent-system.md §4 "J4", §7), isolated from the graph and any
 * `DecisionPort` -- same split task 3 made for `choosePlanSpecialists` (planning.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceItem, Finding, GroundingViolation } from '@payops/shared';
import {
  applyGroundingRules,
  applyStructuralGrounding,
  computeGaps,
  MAX_INVESTIGATION_ROUNDS,
  survivingFindings,
  type SupportAnswer,
} from './grounding';
import { buildResolveContext } from './context';
import { FINDING_PREDICATES } from './grounding/predicates';

const evidence: EvidenceItem[] = [
  { id: 'ev_01', source: 'getWebhookDeliveries', system: 'WEBHOOK', entityRef: 'wh_1', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { finalStatus: 'FAILED', lastHttpStatus: 500, event: 'payment.captured', attempts: 1 } },
  { id: 'ev_02', source: 'getCustomerHistory', system: 'RISK', entityRef: 'cus_1', observedAt: '2026-01-01T00:00:00Z', stepId: 'triage', facts: { accountAgeDays: 1 } },
];
const evidenceById = new Map(evidence.map((e) => [e.id, e]));

function finding(overrides: Partial<Finding>): Finding {
  return { id: 'fd_01', agent: 'payment', code: 'WEBHOOK_HTTP_500', statement: 'The webhook failed with HTTP 500 [ev_01].', evidenceIds: ['ev_01'], confidence: 0.9, ...overrides };
}

describe('applyStructuralGrounding (docs/03 §7, before J4)', () => {
  it('keeps a finding whose cited evidence satisfies its FindingCode predicate', () => {
    const result = applyStructuralGrounding([finding({})], evidenceById);
    expect(result.violations).toHaveLength(0);
    expect(result.sound).toHaveLength(1);
  });

  it('drops a finding that cites an evidence id that does not exist', () => {
    const bad = finding({ id: 'fd_02', evidenceIds: ['ev_99'] });
    const result = applyStructuralGrounding([bad], evidenceById);
    expect(result.sound).toHaveLength(0);
    expect(result.violations).toEqual([{ findingId: 'fd_02', reason: 'cites an evidence id that does not exist' }]);
  });

  it('drops a finding whose cited evidence fails its own FindingCode predicate (the corrupted-finding case)', () => {
    // ev_02 is real RISK evidence, but WEBHOOK_HTTP_500 requires a cited WEBHOOK item with
    // lastHttpStatus >= 500 -- citing real-but-wrong evidence is exactly the "hallucinated root
    // cause" case §7 exists to catch.
    const corrupted = finding({ id: 'fd_03', evidenceIds: ['ev_02'] });
    const result = applyStructuralGrounding([corrupted], evidenceById);
    expect(result.sound).toHaveLength(0);
    expect(result.violations[0]).toMatchObject({ findingId: 'fd_03' });
    expect(FINDING_PREDICATES.WEBHOOK_HTTP_500([evidenceById.get('ev_02')!])).toBe(false);
  });

  it('keeps sound findings and drops unsound ones in the same batch', () => {
    const sound = finding({ id: 'fd_01' });
    const unsound = finding({ id: 'fd_02', evidenceIds: ['ev_02'] });
    const result = applyStructuralGrounding([sound, unsound], evidenceById);
    expect(result.sound.map((f) => f.id)).toEqual(['fd_01']);
    expect(result.violations.map((v) => v.findingId)).toEqual(['fd_02']);
  });
});

describe('applyGroundingRules (docs/03 §4 "J4" code rules)', () => {
  const base = { findings: [finding({})], structuralViolations: [] as GroundingViolation[], agentsVisited: ['payment'] };

  it('drops a finding Jev marks contradicted at confidence >= 0.5, and records a GroundingViolation', () => {
    const answers: SupportAnswer[] = [{ findingId: 'fd_01', choice: 'contradicted', confidence: 0.9 }];
    const result = applyGroundingRules({ ...base, semanticAnswers: answers, sufficientNoul: 0.9, investigationRound: 1 });
    expect(result.survivingFindings).toHaveLength(0);
    expect(result.violations).toEqual([{ findingId: 'fd_01', reason: 'Jev J4 marked this claim contradicted by its cited evidence' }]);
    expect(result.needsHumanReview).toBe(false);
  });

  it('keeps a finding Jev marks contradicted below the 0.5 confidence floor', () => {
    const answers: SupportAnswer[] = [{ findingId: 'fd_01', choice: 'contradicted', confidence: 0.4 }];
    const result = applyGroundingRules({ ...base, semanticAnswers: answers, sufficientNoul: 0.9, investigationRound: 1 });
    expect(result.survivingFindings.map((f) => f.id)).toEqual(['fd_01']);
    expect(result.violations).toHaveLength(0);
  });

  it('keeps a finding Jev marks supported or not_enough_evidence', () => {
    const answers: SupportAnswer[] = [{ findingId: 'fd_01', choice: 'supported', confidence: 0.99 }];
    const result = applyGroundingRules({ ...base, semanticAnswers: answers, sufficientNoul: 0.9, investigationRound: 1 });
    expect(result.survivingFindings.map((f) => f.id)).toEqual(['fd_01']);
  });

  it('sufficient < 0.5 and investigationRound < MAX -> gaps for agents with no surviving findings', () => {
    const answers: SupportAnswer[] = [{ findingId: 'fd_01', choice: 'contradicted', confidence: 0.9 }];
    const result = applyGroundingRules({
      findings: [finding({})],
      structuralViolations: [],
      semanticAnswers: answers,
      sufficientNoul: 0.2,
      agentsVisited: ['payment', 'risk'],
      investigationRound: 1,
    });
    expect(result.sufficient).toBe(false);
    expect(result.gaps).toEqual([
      { agent: 'payment', reason: 'payment ran but has no findings that survived grounding' },
      { agent: 'risk', reason: 'risk ran but has no findings that survived grounding' },
    ]);
  });

  it('never loops back once investigationRound has reached MAX_INVESTIGATION_ROUNDS, even when insufficient', () => {
    const answers: SupportAnswer[] = [{ findingId: 'fd_01', choice: 'contradicted', confidence: 0.9 }];
    const result = applyGroundingRules({
      findings: [finding({})],
      structuralViolations: [],
      semanticAnswers: answers,
      sufficientNoul: 0.1,
      agentsVisited: ['payment'],
      investigationRound: MAX_INVESTIGATION_ROUNDS,
    });
    expect(result.sufficient).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  it('J4 fallback (Jev error/timeout): structural check only, needsHumanReview set, never adds a round on its own', () => {
    const result = applyGroundingRules({
      findings: [finding({})],
      structuralViolations: [{ findingId: 'fd_00', reason: 'cites an evidence id that does not exist' }],
      semanticAnswers: null,
      sufficientNoul: null,
      agentsVisited: ['payment'],
      investigationRound: 1,
    });
    expect(result.needsHumanReview).toBe(true);
    expect(result.sufficient).toBe(true); // never forces a round from the error alone
    expect(result.gaps).toEqual([]);
    expect(result.survivingFindings.map((f) => f.id)).toEqual(['fd_01']); // structural violation from a different id, this finding is untouched
    expect(result.violations).toEqual([{ findingId: 'fd_00', reason: 'cites an evidence id that does not exist' }]);
  });
});

describe('computeGaps', () => {
  it('names only visited agents with zero surviving findings, in AGENT_NAMES order', () => {
    const gaps = computeGaps(['risk', 'payment'], [finding({ agent: 'payment' })]);
    expect(gaps).toEqual([{ agent: 'risk', reason: 'risk ran but has no findings that survived grounding' }]);
  });

  it('never names an agent that did not run, even with zero findings', () => {
    expect(computeGaps(['payment'], [])).toEqual([{ agent: 'payment', reason: 'payment ran but has no findings that survived grounding' }]);
    expect(computeGaps([], [])).toEqual([]);
  });
});

describe('survivingFindings', () => {
  it('excludes findings named in violations, keeps the rest', () => {
    const findings = [finding({ id: 'fd_01' }), finding({ id: 'fd_02' })];
    const result = survivingFindings(findings, [{ findingId: 'fd_02', reason: 'dropped' }]);
    expect(result.map((f) => f.id)).toEqual(['fd_01']);
  });

  it('is a no-op copy when there are no violations (fast path, grounding never ran)', () => {
    const findings = [finding({ id: 'fd_01' })];
    expect(survivingFindings(findings, undefined)).toEqual(findings);
    expect(survivingFindings(findings, [])).toEqual(findings);
  });
});

describe('a dropped finding never reaches resolve (Phase 4 "Done when")', () => {
  it('is absent from the built resolve context once grounding drops it, even though state.findings is append-only', () => {
    const clean = finding({ id: 'fd_01', statement: 'The webhook failed with HTTP 500 [ev_01].' });
    const corrupted = finding({ id: 'fd_02', code: 'RISK_SIGNAL', evidenceIds: ['ev_01'], statement: 'CORRUPTED_UNSUPPORTED_CLAIM_TEXT [ev_01].' });
    // corrupted cites WEBHOOK evidence for a RISK_SIGNAL claim -- structurally caught up front.
    const structural = applyStructuralGrounding([clean, corrupted], evidenceById);
    expect(structural.sound.map((f) => f.id)).toEqual(['fd_01']);

    const rules = applyGroundingRules({
      findings: [clean, corrupted], // append-only: both are still "in state.findings"
      structuralViolations: structural.violations,
      semanticAnswers: [],
      sufficientNoul: 0.9,
      agentsVisited: ['payment'],
      investigationRound: 1,
    });
    expect(rules.violations.map((v) => v.findingId)).toEqual(['fd_02']);

    // Exactly what nodes.ts's `resolve` does: filter the (still append-only) findings pool by
    // the grounding report before ever building a context or calling the diagnosis LLM.
    const grounded = survivingFindings([clean, corrupted], rules.violations);
    const built = buildResolveContext({
      brief: { caseId: 'c', displayId: 'PAY-0001', type: 'X', detectionRuleIds: [], amountBand: 'LOW', mismatchedSystems: [], flags: { hasRefund: false, hasSettlementBatch: false, isDuplicate: false, quarantinedText: false } },
      findings: grounded,
      evidenceCount: evidence.length,
      risk: null,
      grounding: { checked: 2, violations: rules.violations, sufficient: true },
      history: [],
    });
    const rendered = built.messages.map((m) => m.content).join('\n');
    expect(rendered).toContain('fd_01');
    expect(rendered).not.toContain('fd_02');
    expect(rendered).not.toContain('CORRUPTED_UNSUPPORTED_CLAIM_TEXT');
  });
});
