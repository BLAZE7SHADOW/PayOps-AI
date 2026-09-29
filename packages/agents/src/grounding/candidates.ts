/**
 * Candidate root causes (P1 task 2b, D064). The root-cause checks (root-cause-checks.ts) started
 * as a veto: a wrong label became UNKNOWN and the case escalated. Here the same checks also
 * generate candidates, so code can often recover the right label itself and the model can no
 * longer pick a label the evidence does not support.
 *
 * Causes form chains where an upstream cause explains the ones below it (a failed webhook is why
 * the order stayed FAILED and why no ledger credit was posted). Within a chain only the most
 * upstream supported cause is a real candidate. Different chains are independent explanations,
 * so more than one leader means the case is ambiguous and a person decides.
 */
import type { EvidenceItem, RootCause } from '@payops/shared';
import { checkRootCause } from './root-cause-checks';

/** Confidence given to a label that code substituted for the agent's. It is below the policy's
 * low-confidence threshold (0.60, rule P8) on purpose, so a person approves the fix. */
export const CODE_OVERRIDE_CONFIDENCE = 0.5;

/** Each chain is ordered from the most upstream cause to the most downstream. */
export const CAUSE_CHAINS: readonly (readonly Exclude<RootCause, 'UNKNOWN'>[])[] = [
  ['WEBHOOK_PROCESSING_FAILURE', 'WEBHOOK_NOT_DELIVERED', 'ORDER_STATE_DIVERGED', 'LEDGER_POSTING_MISSING'],
  ['DUPLICATE_CAPTURE'],
  ['REFUND_NOT_INITIATED', 'REFUND_FAILED_AT_GATEWAY', 'REFUND_STATUS_NOT_SYNCED'],
  ['SETTLEMENT_FEE_MISMATCH', 'SETTLEMENT_LINE_MISSING'],
  ['SUSPECTED_FRAUD'],
];

/** The most upstream supported cause of every chain that has one, in chain order. */
export function candidateLeaders(evidence: readonly EvidenceItem[]): RootCause[] {
  const leaders: RootCause[] = [];
  for (const chain of CAUSE_CHAINS) {
    const leader = chain.find((cause) => checkRootCause(cause, evidence).ok);
    if (leader) leaders.push(leader);
  }
  return leaders;
}

export type Reconciliation =
  | { kind: 'KEEP' }
  | { kind: 'REPLACE'; rootCause: RootCause; reason: string }
  | { kind: 'ESCALATE'; candidates: RootCause[]; reason: string };

/**
 * Compares the label the agent chose with what the evidence supports.
 * - KEEP: the label is confirmed and is the leader of its chain (or the agent said UNKNOWN).
 * - REPLACE: code found the label to be downstream of a supported cause, or wrong with exactly
 *   one supported candidate left.
 * - ESCALATE: the label is wrong and the evidence supports none or several candidates.
 */
export function reconcileDiagnosis(chosen: RootCause, evidence: readonly EvidenceItem[]): Reconciliation {
  if (chosen === 'UNKNOWN') return { kind: 'KEEP' };
  const leaders = candidateLeaders(evidence);
  const check = checkRootCause(chosen, evidence);

  if (check.ok) {
    const chain = CAUSE_CHAINS.find((c) => c.includes(chosen as Exclude<RootCause, 'UNKNOWN'>))!;
    const leader = leaders.find((l) => chain.includes(l as Exclude<RootCause, 'UNKNOWN'>));
    if (!leader || leader === chosen) return { kind: 'KEEP' };
    return {
      kind: 'REPLACE',
      rootCause: leader,
      reason: `${chosen} is a downstream effect of ${leader}, which the evidence also supports.`,
    };
  }

  if (leaders.length === 1) {
    return { kind: 'REPLACE', rootCause: leaders[0]!, reason: `The stated cause ${chosen} was not confirmed: ${check.reason}` };
  }
  return {
    kind: 'ESCALATE',
    candidates: leaders,
    reason: `The stated cause ${chosen} was not confirmed: ${check.reason}`,
  };
}
