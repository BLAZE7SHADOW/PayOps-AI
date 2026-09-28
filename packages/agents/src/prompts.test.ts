import { expect, it } from 'vitest';
import type { CaseBrief, EvidenceItem } from '@payops/shared';
import { followUpPrompt } from './prompts';
const brief: CaseBrief = { caseId: 'case_a', displayId: 'PAY-0001', type: 'PAYMENT_MISMATCH', detectionRuleIds: ['D1_CAPTURED_NOT_PAID'], amountBand: 'HIGH', mismatchedSystems: ['ORDER'], flags: { hasRefund: false, hasSettlementBatch: false, isDuplicate: false, quarantinedText: false } };
const evidence: EvidenceItem = { id: 'ev_01', source: 'getGatewayPayment', system: 'GATEWAY', entityRef: 'gwp_a', observedAt: '2026-09-28T12:00:00Z', stepId: 'triage', facts: { status: 'CAPTURED', amountMinor: 50000, capturedAt: '2026-09-28T12:00:00Z', gwPaymentId: 'gwp_a' } };
it('replays equivalent facts despite regenerated ids and observation times', () => {
  expect(followUpPrompt(brief, [evidence])).toEqual(followUpPrompt({ ...brief, caseId: 'case_b', displayId: 'PAY-0099' }, [{ ...evidence, entityRef: 'gwp_b', observedAt: '2026-09-29T12:00:00Z', facts: { ...evidence.facts, capturedAt: '2026-09-29T12:00:00Z', gwPaymentId: 'gwp_b' } }]));
});
it('never treats different financial facts as the same prompt', () => {
  expect(followUpPrompt(brief, [evidence])).not.toEqual(followUpPrompt(brief, [{ ...evidence, facts: { ...evidence.facts, amountMinor: 60000 } }]));
});
