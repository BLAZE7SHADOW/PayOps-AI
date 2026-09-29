/**
 * Candidate root causes (P1 task 2b): every cause whose code check passes, reduced to one leader
 * per causal chain (the most upstream cause that passes, since it explains the ones below it).
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@payops/shared';
import { candidateLeaders, reconcileDiagnosis } from './candidates';

let n = 0;
function ev(source: string, system: EvidenceItem['system'], facts: EvidenceItem['facts'], entityRef?: string): EvidenceItem {
  n += 1;
  return { id: `ev_${n}`, source, system, entityRef: entityRef ?? `ent_${n}`, facts, observedAt: '2026-01-01T00:00:00Z', stepId: 'test' };
}
const gw = () => ev('getGatewayPayment', 'GATEWAY', { status: 'CAPTURED' });
const order = (status: string) => ev('getOrder', 'ORDER', { status });
const webhook = (finalStatus: string, lastHttpStatus: number) => ev('getWebhookDeliveries', 'WEBHOOK', { finalStatus, lastHttpStatus, attempts: 3 });

// The captured/order-failed shape: webhook 500, order FAILED, no ledger credit.
const capturedOrderFailed = () => [gw(), order('FAILED'), webhook('FAILED', 500)];

describe('candidateLeaders', () => {
  it('keeps only the most upstream cause of a causal chain', () => {
    // WEBHOOK_PROCESSING_FAILURE, ORDER_STATE_DIVERGED and LEDGER_POSTING_MISSING all pass here.
    expect(candidateLeaders(capturedOrderFailed())).toEqual(['WEBHOOK_PROCESSING_FAILURE']);
  });

  it('returns an empty list when nothing is supported', () => {
    expect(candidateLeaders([])).toEqual([]);
  });

  it('never returns UNKNOWN', () => {
    expect(candidateLeaders(capturedOrderFailed())).not.toContain('UNKNOWN');
  });
});

describe('reconcileDiagnosis', () => {
  it('keeps a label that is confirmed and already the chain leader', () => {
    expect(reconcileDiagnosis('WEBHOOK_PROCESSING_FAILURE', capturedOrderFailed())).toEqual({ kind: 'KEEP' });
  });

  it('promotes a confirmed but downstream label to the upstream cause', () => {
    expect(reconcileDiagnosis('ORDER_STATE_DIVERGED', capturedOrderFailed())).toEqual({
      kind: 'REPLACE',
      rootCause: 'WEBHOOK_PROCESSING_FAILURE',
      reason: expect.stringContaining('ORDER_STATE_DIVERGED'),
    });
  });

  it('replaces a rejected label when exactly one candidate remains', () => {
    // The agent said WEBHOOK_NOT_DELIVERED, but the consumer answered 500.
    expect(reconcileDiagnosis('WEBHOOK_NOT_DELIVERED', capturedOrderFailed())).toMatchObject({
      kind: 'REPLACE',
      rootCause: 'WEBHOOK_PROCESSING_FAILURE',
    });
  });

  it('escalates a rejected label when nothing is supported', () => {
    expect(reconcileDiagnosis('DUPLICATE_CAPTURE', [])).toMatchObject({ kind: 'ESCALATE', candidates: [] });
  });

  it('escalates with the candidate list when several chains are supported', () => {
    const evidence = [
      ...capturedOrderFailed(),
      ev('getCustomerHistory', 'RISK', { failed24h: 5 }),
    ];
    const result = reconcileDiagnosis('DUPLICATE_CAPTURE', evidence);
    expect(result.kind).toBe('ESCALATE');
    if (result.kind === 'ESCALATE') expect(result.candidates).toEqual(['WEBHOOK_PROCESSING_FAILURE', 'SUSPECTED_FRAUD']);
  });

  it('keeps UNKNOWN as UNKNOWN', () => {
    expect(reconcileDiagnosis('UNKNOWN', capturedOrderFailed())).toEqual({ kind: 'KEEP' });
  });
});
