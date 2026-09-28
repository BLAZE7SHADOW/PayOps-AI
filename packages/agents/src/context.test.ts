import { describe, expect, it } from 'vitest';
import type { CaseBrief, EvidenceItem, Finding } from '@payops/shared';
import {
  applyBudget,
  buildResolveContext,
  buildSpecialistContext,
  estimateTokens,
  maskEmail,
  maskPhone,
  maskPiiInFacts,
  sliceEvidenceForAgent,
  type ContextDraft,
} from './context';
import { PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS, RECONCILIATION_TOOLS } from './tools';

const brief: CaseBrief = {
  caseId: 'case_a',
  displayId: 'PAY-0001',
  type: 'PAYMENT_MISMATCH',
  detectionRuleIds: ['D1_CAPTURED_NOT_PAID'],
  amountBand: 'HIGH',
  mismatchedSystems: ['ORDER'],
  flags: { hasRefund: false, hasSettlementBatch: false, isDuplicate: false, quarantinedText: false },
};

const gatewayEvidence: EvidenceItem = {
  id: 'ev_01',
  source: 'getGatewayPayment',
  system: 'GATEWAY',
  entityRef: 'gwp_a',
  observedAt: '2026-09-28T12:00:00Z',
  stepId: 'triage',
  facts: { status: 'CAPTURED', amountMinor: 50000, capturedAt: '2026-09-28T12:00:00Z', gwPaymentId: 'gwp_a' },
};
const orderEvidence: EvidenceItem = {
  id: 'ev_02',
  source: 'getOrder',
  system: 'ORDER',
  entityRef: 'ord_a',
  observedAt: '2026-09-28T11:00:00Z',
  stepId: 'triage',
  facts: { status: 'PENDING', amountMinor: 50000 },
};
const ledgerEvidence: EvidenceItem = {
  id: 'ev_03',
  source: 'getLedgerEntries',
  system: 'LEDGER',
  entityRef: 'jrn_a',
  observedAt: '2026-09-28T10:00:00Z',
  stepId: 'triage',
  facts: { account: 'CASH', direction: 'DEBIT', amountMinor: 50000, source: 'CAPTURE' },
};

describe('applyBudget (docs/03 §8 drop order [5] -> [4] -> oldest evidence)', () => {
  const draft: ContextDraft = {
    prefix: 'PREFIX',
    brief: 'BRIEF',
    sliceHeader: 'Evidence:',
    slice: [
      { id: 'ev_old', text: 'oldest evidence line', observedAt: '2026-01-01T00:00:00Z' },
      { id: 'ev_new', text: 'newest evidence line', observedAt: '2026-02-01T00:00:00Z' },
    ],
    peers: 'PEER SUMMARY',
    history: 'HISTORY',
    task: 'TASK',
  };

  it('keeps every section when the draft already fits the budget', () => {
    const result = applyBudget(draft, 10_000);
    expect(result.droppedHistory).toBe(false);
    expect(result.droppedPeers).toBe(false);
    expect(result.droppedEvidenceIds).toEqual([]);
    expect(result.history).toBe('HISTORY');
    expect(result.peers).toBe('PEER SUMMARY');
    expect(result.slice).toHaveLength(2);
  });

  it('drops history first, before touching peers or evidence', () => {
    // Budget below the full draft's size but comfortably above the draft with history removed.
    const full = estimateTokens([draft.prefix, draft.brief, draft.sliceHeader, draft.peers, draft.history, draft.task].join('\n\n'));
    const withoutHistory = estimateTokens([draft.prefix, draft.brief, draft.sliceHeader, draft.peers, draft.task].join('\n\n'));
    const budget = Math.floor((full + withoutHistory) / 2);
    const result = applyBudget(draft, budget);
    expect(result.droppedHistory).toBe(true);
    expect(result.droppedPeers).toBe(false);
    expect(result.droppedEvidenceIds).toEqual([]);
    expect(result.peers).toBe('PEER SUMMARY');
  });

  it('drops peers next, only once history alone is not enough', () => {
    const result = applyBudget(draft, 20);
    expect(result.droppedHistory).toBe(true);
    expect(result.droppedPeers).toBe(true);
    // Evidence may or may not need trimming at this tiny budget, but prefix/brief/task never drop.
    expect(result.prefix).toBe('PREFIX');
    expect(result.brief).toBe('BRIEF');
    expect(result.task).toBe('TASK');
  });

  it('drops the oldest evidence item first when peers and history are already gone', () => {
    const draftNoPeersHistory: ContextDraft = { ...draft, peers: '', history: '' };
    // A budget that fits one evidence line but not two.
    const withBoth = estimateTokens([draftNoPeersHistory.prefix, draftNoPeersHistory.brief, draftNoPeersHistory.sliceHeader, 'oldest evidence line\nnewest evidence line', draftNoPeersHistory.task].join('\n\n'));
    const withOne = estimateTokens([draftNoPeersHistory.prefix, draftNoPeersHistory.brief, draftNoPeersHistory.sliceHeader, 'newest evidence line', draftNoPeersHistory.task].join('\n\n'));
    const budget = Math.floor((withBoth + withOne) / 2);
    const result = applyBudget(draftNoPeersHistory, budget);
    expect(result.droppedEvidenceIds).toEqual(['ev_old']);
    expect(result.slice.map((s) => s.id)).toEqual(['ev_new']);
  });

  it('empties the slice entirely rather than exceeding an impossibly small budget forever', () => {
    const result = applyBudget(draft, 1);
    expect(result.slice).toEqual([]);
    expect(result.droppedEvidenceIds.sort()).toEqual(['ev_new', 'ev_old']);
  });
});

describe('sliceEvidenceForAgent / buildSpecialistContext scoping (docs/03 §3/§8 "never contains")', () => {
  const allEvidence = [gatewayEvidence, orderEvidence, ledgerEvidence];

  it('scopes a specialist to only its own tool group', () => {
    const paymentSlice = sliceEvidenceForAgent(allEvidence, PAYMENT_TOOLS);
    expect(paymentSlice.map((e) => e.id).sort()).toEqual(['ev_01', 'ev_02']);
    const reconSlice = sliceEvidenceForAgent(allEvidence, RECONCILIATION_TOOLS);
    expect(reconSlice.map((e) => e.id)).toEqual(['ev_03']);
  });

  it("payment specialist's built context never contains reconciliation evidence", () => {
    const built = buildSpecialistContext({
      agent: 'payment',
      callType: 'findings',
      brief,
      evidence: allEvidence,
      ownTools: PAYMENT_TOOLS,
    });
    const text = built.messages.map((m) => m.content).join('\n');
    expect(text).toContain('ev_01');
    expect(text).toContain('ev_02');
    expect(text).not.toContain('ev_03');
    expect(text).not.toContain('LEDGER');
  });

  it("reconciliation specialist's built context never contains payment/gateway evidence", () => {
    const built = buildSpecialistContext({
      agent: 'reconciliation',
      callType: 'findings',
      brief,
      evidence: allEvidence,
      ownTools: RECONCILIATION_TOOLS,
    });
    const text = built.messages.map((m) => m.content).join('\n');
    expect(text).toContain('ev_03');
    expect(text).not.toContain('ev_01');
    expect(text).not.toContain('ev_02');
    expect(text).not.toContain('GATEWAY');
  });

  it('a followUp call lists only that agent\'s own follow-up tool catalog', () => {
    const built = buildSpecialistContext({
      agent: 'payment',
      callType: 'followUp',
      brief,
      evidence: allEvidence,
      ownTools: PAYMENT_TOOLS,
      followUpTools: PAYMENT_FOLLOWUP_TOOLS,
    });
    const system = built.messages[0]!.content;
    expect(system).toContain('getOrderTimeline'); // a payment follow-up tool
    expect(system).not.toContain('getSettlementLines'); // a reconciliation tool
  });

  it('computes the payment amount comparison in code, never leaving it for the model', () => {
    const built = buildSpecialistContext({
      agent: 'payment',
      callType: 'findings',
      brief,
      evidence: allEvidence,
      ownTools: PAYMENT_TOOLS,
    });
    const text = built.messages.map((m) => m.content).join('\n');
    expect(text).toContain('gatewayVsOrderAmount: EQUAL');
  });

  it('replays equivalent facts despite regenerated ids and observation times (docs/DECISIONS.md D034)', () => {
    const a = buildSpecialistContext({ agent: 'payment', callType: 'followUp', brief, evidence: [gatewayEvidence], ownTools: PAYMENT_TOOLS, followUpTools: PAYMENT_FOLLOWUP_TOOLS });
    const b = buildSpecialistContext({
      agent: 'payment',
      callType: 'followUp',
      brief: { ...brief, caseId: 'case_b', displayId: 'PAY-0099' },
      evidence: [{ ...gatewayEvidence, entityRef: 'gwp_b', observedAt: '2026-09-29T12:00:00Z', facts: { ...gatewayEvidence.facts, capturedAt: '2026-09-29T12:00:00Z', gwPaymentId: 'gwp_b' } }],
      ownTools: PAYMENT_TOOLS,
      followUpTools: PAYMENT_FOLLOWUP_TOOLS,
    });
    expect(a.messages).toEqual(b.messages);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('never treats different financial facts as the same prompt', () => {
    const a = buildSpecialistContext({ agent: 'payment', callType: 'followUp', brief, evidence: [gatewayEvidence], ownTools: PAYMENT_TOOLS, followUpTools: PAYMENT_FOLLOWUP_TOOLS });
    const b = buildSpecialistContext({
      agent: 'payment',
      callType: 'followUp',
      brief,
      evidence: [{ ...gatewayEvidence, facts: { ...gatewayEvidence.facts, amountMinor: 60000 } }],
      ownTools: PAYMENT_TOOLS,
      followUpTools: PAYMENT_FOLLOWUP_TOOLS,
    });
    expect(a.messages).not.toEqual(b.messages);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('buildResolveContext peer summaries (docs/03 §8 "[4] peer summaries ... resolve only")', () => {
  const findings: Finding[] = [
    { id: 'fd_01', agent: 'payment', code: 'ORDER_STATE_DIVERGED', statement: 'Gateway captured but order is pending [ev_01, ev_02].', evidenceIds: ['ev_01', 'ev_02'], confidence: 0.9 },
    { id: 'fd_02', agent: 'reconciliation', code: 'SETTLEMENT_FEE_DIFF', statement: 'Ledger entry posted for the capture [ev_03].', evidenceIds: ['ev_03'], confidence: 0.7 },
  ];

  it('groups findings by the agent that produced them and never repeats raw evidence facts', () => {
    const built = buildResolveContext({ brief, findings, evidenceCount: 3, risk: null, grounding: null, history: [] });
    const text = built.messages.map((m) => m.content).join('\n');
    expect(text).toContain('payment:');
    expect(text).toContain('reconciliation:');
    expect(text).toContain('fd_01');
    expect(text).toContain('fd_02');
    // The statements cite evidence ids, but the raw fact dicts (e.g. amountMinor/status JSON) never appear.
    expect(text).not.toContain('"amountMinor"');
    expect(text).not.toContain('"status"');
  });

  it('includes the action catalog and risk/grounding summary in the structural slice', () => {
    const built = buildResolveContext({
      brief,
      findings,
      evidenceCount: 3,
      risk: { tier: 'HIGH', scores: {}, meanConfidence: 0.6 },
      grounding: { checked: 2, violations: [], sufficient: true },
      history: [],
    });
    const text = built.messages.map((m) => m.content).join('\n');
    expect(text).toContain('ESCALATE_TO_HUMAN');
    expect(text).toContain('HIGH');
    expect(text).toContain('sufficient=true');
  });
});

describe('PII masking (docs/03 §8 "Projection")', () => {
  it('masks an email to first-char + stars + domain', () => {
    expect(maskEmail('rahul@gmail.com')).toBe('r****@gmail.com');
  });

  it('masks a phone number to country code + stars + last 4 digits', () => {
    expect(maskPhone('+919876554321')).toBe('+91 ******4321');
  });

  it('leaves non-PII facts untouched and masks only email/phone-shaped keys', () => {
    const masked = maskPiiInFacts({ customerEmail: 'rahul@gmail.com', customerPhone: '+919876554321', status: 'CAPTURED', amountMinor: 50000 });
    expect(masked.customerEmail).toBe('r****@gmail.com');
    expect(masked.customerPhone).toBe('+91 ******4321');
    expect(masked.status).toBe('CAPTURED');
    expect(masked.amountMinor).toBe(50000);
  });
});

describe('estimateTokens (docs/DECISIONS.md D039: chars/4 heuristic)', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is a positive number that roughly tracks input length', () => {
    const short = estimateTokens('a short prompt');
    const long = estimateTokens('a short prompt'.repeat(20));
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(short * 25); // roughly linear, not exact
  });
});
