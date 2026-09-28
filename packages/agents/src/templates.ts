/**
 * Fast-path resolution templates (docs/03-agent-system.md §4a): `RootCause → CatalogAction[]`,
 * reusing the manual-path recommendations in `core/actions/options.ts` so a proposed action
 * always carries valid ids and params for this specific case. `rootCause` drives the special
 * cases (UNKNOWN always escalates) and the narrative; the concrete action set comes from the
 * case's own shape, which is the same information a person resolving it manually would see.
 */
import { actionOptions, recommendedTypes, type AttemptHistory, type CaseState } from '@payops/core';
import { formatMoney, type CatalogAction, type EvidenceItem, type RootCause } from '@payops/shared';

export interface TemplateProposal {
  actions: CatalogAction[];
  rationale: string;
  citedEvidenceIds: string[];
}

function escalateAction(state: CaseState, history: AttemptHistory[]): CatalogAction {
  const option = actionOptions(state, history).find((o) => o.type === 'ESCALATE_TO_HUMAN');
  return option?.action ?? { type: 'ESCALATE_TO_HUMAN', params: { reason: 'Needs a person to review', to: 'MANAGER' } };
}

/** The concrete actions for a diagnosed root cause, given this case's actual shape. */
export function templateActions(rootCause: RootCause, state: CaseState, history: AttemptHistory[] = []): CatalogAction[] {
  if (rootCause === 'UNKNOWN') return [escalateAction(state, history)];
  const options = actionOptions(state, history);
  const byType = new Map(options.map((o) => [o.type, o]));
  const recommended = recommendedTypes(state, history).filter((t) => byType.get(t)?.available);
  if (recommended.length === 0) return [escalateAction(state, history)];
  return recommended.map((t) => byType.get(t)!.action);
}

function findEvidence(evidence: readonly EvidenceItem[], predicate: (e: EvidenceItem) => boolean): EvidenceItem | null {
  return evidence.find(predicate) ?? null;
}

/** A one-sentence, evidence-citing narrative in the house style (docs/03 §4a: "narrative templates"). */
export function narrativeFor(rootCause: RootCause, evidence: readonly EvidenceItem[]): { text: string; citedIds: string[] } {
  switch (rootCause) {
    case 'WEBHOOK_PROCESSING_FAILURE': {
      const w = findEvidence(evidence, (e) => e.system === 'WEBHOOK' && Number(e.facts.lastHttpStatus) >= 500);
      return w
        ? { text: `The captured webhook failed with HTTP ${w.facts.lastHttpStatus} after ${w.facts.attempts} attempt(s) [${w.id}].`, citedIds: [w.id] }
        : { text: 'The webhook delivery for this capture did not process cleanly.', citedIds: [] };
    }
    case 'WEBHOOK_NOT_DELIVERED': {
      const w = findEvidence(evidence, (e) => e.system === 'WEBHOOK' && e.facts.finalStatus !== 'DELIVERED');
      return w
        ? { text: `The webhook for this payment was never delivered (status ${w.facts.finalStatus}) [${w.id}].`, citedIds: [w.id] }
        : { text: 'A webhook event for this payment was not delivered.', citedIds: [] };
    }
    case 'ORDER_STATE_DIVERGED': {
      const g = findEvidence(evidence, (e) => e.system === 'GATEWAY');
      const o = findEvidence(evidence, (e) => e.system === 'ORDER');
      const ids = [g?.id, o?.id].filter((x): x is string => !!x);
      return {
        text: `The gateway shows this payment as ${g?.facts.status ?? 'captured'} but the order is ${o?.facts.status ?? 'not paid'} [${ids.join(', ')}].`,
        citedIds: ids,
      };
    }
    case 'LEDGER_POSTING_MISSING': {
      const g = findEvidence(evidence, (e) => e.system === 'GATEWAY');
      const ids = g ? [g.id] : [];
      return { text: `The gateway captured ${formatMoney(Number(g?.facts.amountMinor ?? 0))} but no ledger credit was posted for it${ids.length ? ` [${ids[0]}]` : ''}.`, citedIds: ids };
    }
    case 'DUPLICATE_CAPTURE': {
      const gw = evidence.filter((e) => e.system === 'GATEWAY' && e.facts.status === 'CAPTURED');
      const ids = gw.map((g) => g.id);
      return { text: `More than one capture exists for this order [${ids.join(', ')}]; the extra capture needs a refund.`, citedIds: ids };
    }
    case 'REFUND_STATUS_NOT_SYNCED': {
      const r = findEvidence(evidence, (e) => e.system === 'REFUND' && e.source === 'getRefundGatewayStatus');
      const ids = r ? [r.id] : [];
      return { text: `The gateway refund is ${r?.facts.status ?? 'processed'} but our record has not been updated to match${ids.length ? ` [${ids[0]}]` : ''}.`, citedIds: ids };
    }
    case 'REFUND_NOT_INITIATED': {
      const o = findEvidence(evidence, (e) => e.system === 'ORDER' && e.facts.status === 'CANCELLED');
      const ids = o ? [o.id] : [];
      return { text: `The order was cancelled after capture but no refund has been initiated${ids.length ? ` [${ids[0]}]` : ''}.`, citedIds: ids };
    }
    case 'REFUND_FAILED_AT_GATEWAY': {
      const r = findEvidence(evidence, (e) => e.system === 'REFUND' && e.facts.status === 'FAILED');
      const ids = r ? [r.id] : [];
      return { text: `The refund failed at the gateway${ids.length ? ` [${ids[0]}]` : ''} and needs a person to review it.`, citedIds: ids };
    }
    case 'SETTLEMENT_FEE_MISMATCH':
    case 'SETTLEMENT_LINE_MISSING': {
      const s = findEvidence(evidence, (e) => e.system === 'SETTLEMENT' && e.source === 'getFeeBreakdown');
      const ids = s ? [s.id] : [];
      return { text: `The settlement batch's reported net differs from what the ledger expects${ids.length ? ` [${ids[0]}]` : ''}.`, citedIds: ids };
    }
    case 'SUSPECTED_FRAUD':
      return { text: 'The velocity and capture pattern on this payment looks unusual and needs a risk review.', citedIds: [] };
    case 'UNKNOWN':
    default:
      return { text: 'The evidence gathered does not point to one clear cause; this needs a person to review.', citedIds: [] };
  }
}
