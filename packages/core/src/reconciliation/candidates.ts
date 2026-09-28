/**
 * Turns rule hits into case candidates. Hits that share `caseType:primaryEntityId` become one
 * candidate (so D1 and D3 on the same payment are one case), which CaseService then opens or
 * merges into the existing open case with that fingerprint.
 */
import {
  SEVERITY_RANK,
  amountBand,
  type CaseType,
  type DetectionRuleId,
  type Severity,
  type StateMatrix,
} from '@payops/shared';
import type { CaseEntityRefs } from '../db/schema';
import { capturedGw } from './facts';
import { buildMatrix } from './matrix';
import { runOrderRules, type RuleHit } from './rules';
import type { OrderSnapshot } from './snapshot';

export interface CaseCandidate {
  fingerprint: string;
  type: CaseType;
  ruleIds: DetectionRuleId[];
  severity: Severity;
  priority: number;
  amountMinor: number;
  entityRefs: CaseEntityRefs;
  matrix: StateMatrix;
}

export function fingerprintOf(hit: Pick<RuleHit, 'caseType' | 'primaryEntity'>): string {
  return `${hit.caseType}:${hit.primaryEntity.id}`;
}

export function maxSeverity(...values: Array<Severity | undefined>): Severity {
  let best: Severity = 'LOW';
  for (const v of values) if (v && SEVERITY_RANK[v] > SEVERITY_RANK[best]) best = v;
  return best;
}

/**
 * Queue order: severity first, then amount in whole rupees (capped so it never spills into the
 * next severity band). Higher is more urgent.
 */
export function priorityOf(severity: Severity, amountMinor: number): number {
  return SEVERITY_RANK[severity] * 1_000_000 + Math.min(999_999, Math.floor(Math.abs(amountMinor) / 100));
}

export function groupHits(
  hits: readonly RuleHit[],
  context: { entityRefs: CaseEntityRefs; matrix: StateMatrix },
): CaseCandidate[] {
  const groups = new Map<string, RuleHit[]>();
  for (const hit of hits) {
    const key = fingerprintOf(hit);
    const list = groups.get(key);
    if (list) list.push(hit);
    else groups.set(key, [hit]);
  }
  return [...groups.entries()].map(([fingerprint, group]) => {
    const first = group[0] as RuleHit;
    const amountMinor = Math.max(...group.map((h) => h.amountMinor));
    const severity = maxSeverity(amountBand(amountMinor), ...group.map((h) => h.severityFloor));
    const entityRefs: CaseEntityRefs = { ...context.entityRefs };
    if (first.primaryEntity.kind === 'batch') entityRefs.batchId = first.primaryEntity.id;
    return {
      fingerprint,
      type: first.caseType,
      ruleIds: [...new Set(group.map((h) => h.ruleId))].sort(),
      severity,
      priority: priorityOf(severity, amountMinor),
      amountMinor,
      entityRefs,
      matrix: context.matrix,
    };
  });
}

/** Every entity a case about this order may need to link to. */
export function snapshotEntityRefs(s: OrderSnapshot): CaseEntityRefs {
  const refs: CaseEntityRefs = {
    orderId: s.order.id,
    customerId: s.customer.id,
    merchantId: s.merchant.id,
  };
  if (s.payment) refs.paymentId = s.payment.id;
  if (s.primaryGw) refs.gwPaymentId = s.primaryGw.id;
  const refund = s.refunds[0];
  if (refund) refs.refundId = refund.id;
  const line = s.settlementLines.find((l) => l.gwPaymentId === s.primaryGw?.id);
  if (line) refs.batchId = line.batchId;
  const captured = capturedGw(s);
  if (captured.length > 1) {
    refs.duplicateGwPaymentIds = captured.filter((g) => g.id !== s.primaryGw?.id).map((g) => g.id);
  }
  return refs;
}

export interface OrderEvaluation {
  matrix: StateMatrix;
  hits: RuleHit[];
  candidates: CaseCandidate[];
}

/** Matrix + rules + grouping for one order snapshot. */
export function evaluateOrder(s: OrderSnapshot): OrderEvaluation {
  const matrix = buildMatrix(s);
  const hits = runOrderRules(s);
  return { matrix, hits, candidates: groupHits(hits, { entityRefs: snapshotEntityRefs(s), matrix }) };
}
