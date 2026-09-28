/**
 * Action options for the manual "Resolve" form: every catalog action with parameters prefilled
 * for this case, whether it can run now (from its preconditions), and which ones we recommend
 * for the case's shape. Unavailable options still carry a well-formed action with placeholder ids.
 */
import {
  ACTION_META,
  ACTION_TYPES,
  CASE_TYPE_LABEL,
  formatMoney,
  type ActionOption,
  type ActionType,
  type CatalogAction,
  type ResolutionStatus,
  type ValidationVerdict,
} from '@payops/shared';
import { PAID_ORDER_STATUSES, captureCreditMinor, heldCaptures, isCaptured, lastTransitionAt } from '../reconciliation/facts';
import { d8RiskVelocity } from '../reconciliation/rules';
import type { OrderSnapshot } from '../reconciliation/snapshot';
import { liveCaptureJournals, summarizeJournals } from '../services/ledger.service';
import { refundableMinor } from './facts';
import { preconditionsOf } from './registry';
import type { CaseState } from './types';

/** What earlier attempts on the case did, for recommendations. */
export interface AttemptHistory {
  actionTypes: ActionType[];
  status: ResolutionStatus;
  verdict: ValidationVerdict | null;
}

const NONE = 'none';

/** Plain reason when the case has nothing for the action to act on (params hold the NONE placeholder). */
const MISSING_SUBJECT: Record<ActionType, string> = {
  REPLAY_WEBHOOK_EVENT: 'No webhook event on this case to replay.',
  MARK_ORDER_PAID: 'No order and captured payment on this case.',
  POST_LEDGER_ENTRY: 'No internal payment on this case to post.',
  REVERSE_LEDGER_ENTRY: 'No ledger journal on this case to reverse.',
  INITIATE_REFUND: 'No captured gateway payment on this case to refund.',
  SYNC_REFUND_STATUS: 'No refund on this case to sync.',
  RAISE_SETTLEMENT_DISPUTE: 'No settlement batch on this case.',
  HOLD_PAYMENT_FOR_REVIEW: 'No internal payment on this case to hold.',
  ESCALATE_TO_HUMAN: 'Escalation is not possible here.',
};

function missingSubject(action: CatalogAction): string | null {
  const values = Object.values(action.params as Record<string, unknown>);
  return values.includes(NONE) ? MISSING_SUBJECT[action.type] : null;
}

interface Draft {
  action: CatalogAction;
  summary: string;
  editable?: ActionOption['editable'];
  maxAmountMinor?: number | null;
}

type Drafter = (state: CaseState) => Draft;

function replayCandidate(s: OrderSnapshot) {
  const undelivered = s.webhooks.filter((w) => w.finalStatus !== 'DELIVERED');
  return (
    undelivered.find((w) => w.event === 'payment.captured' && w.gwPaymentId === s.primaryGw?.id) ??
    undelivered.find((w) => w.event.startsWith('refund.')) ??
    undelivered[0] ??
    null
  );
}

/** The gateway payment a refund should target: the extra capture for duplicates, else the primary. */
function refundTarget(state: CaseState) {
  const s = state.order;
  if (!s) return null;
  if (state.case.type === 'DUPLICATE') {
    const extra = heldCaptures(s).find((g) => g.id !== s.payment?.gwPaymentId);
    if (extra) return extra;
  }
  return s.primaryGw;
}

function refundReason(state: CaseState): string {
  const s = state.order;
  if (!s) return 'Refund requested by operations';
  if (state.case.type === 'DUPLICATE') return `Duplicate capture on order ${s.order.id}`;
  if (s.order.status === 'CANCELLED') {
    const cancel = [...s.order.timeline].reverse().find((t) => t.to === 'CANCELLED');
    return `Order ${s.order.id} cancelled${cancel?.reason ? `: ${cancel.reason}` : ''}`.slice(0, 200);
  }
  return `Refund requested by operations for order ${s.order.id}`;
}

function escalateReason(state: CaseState): string {
  const s = state.order;
  if (state.case.type === 'RISK_CASE' && s) {
    const hit = d8RiskVelocity({ ...s, payment: s.payment ? { ...s.payment, hold: false } : null });
    if (hit) return `${hit.reason} Needs a risk review.`;
  }
  return `Needs a person to review this ${CASE_TYPE_LABEL[state.case.type].toLowerCase()} case`;
}

const DRAFTERS: Record<ActionType, Drafter> = {
  REPLAY_WEBHOOK_EVENT: (state) => {
    const w = state.order ? replayCandidate(state.order) : null;
    return {
      action: { type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: w?.id ?? state.order?.webhooks[0]?.id ?? NONE } },
      summary: w ? `Replay ${w.event} (${w.id}) to our webhook consumer` : 'Replay a webhook event to our consumer',
    };
  },
  MARK_ORDER_PAID: (state) => {
    const s = state.order;
    const orderId = s?.order.id ?? state.case.entityRefs.orderId ?? NONE;
    const paymentId = s?.payment?.id ?? NONE;
    const gw = s?.primaryGw;
    return {
      action: { type: 'MARK_ORDER_PAID', params: { orderId, paymentId } },
      summary: `Mark order ${orderId} PAID and link payment ${paymentId}${gw && isCaptured(gw) ? ` (gateway captured ${formatMoney(gw.amountMinor)})` : ''}`,
    };
  },
  POST_LEDGER_ENTRY: (state) => {
    const s = state.order;
    const paymentId = s?.payment?.id ?? NONE;
    const gw = s?.gateway.find((g) => g.id === s.payment?.gwPaymentId) ?? s?.primaryGw ?? null;
    const amountMinor = Math.max(1, gw?.amountMinor ?? 1);
    return {
      action: { type: 'POST_LEDGER_ENTRY', params: { paymentId, amountMinor } },
      summary: `Post capture of ${formatMoney(amountMinor)} for ${paymentId}: debit settlement clearing, credit merchant payable`,
    };
  },
  REVERSE_LEDGER_ENTRY: (state) => {
    const ledger = state.order?.ledger ?? [];
    const live = liveCaptureJournals(ledger);
    const journal = live[live.length - 1] ?? summarizeJournals(ledger).find((j) => j.kind !== 'REVERSAL' && !j.reversedBy);
    return {
      action: { type: 'REVERSE_LEDGER_ENTRY', params: { journalId: journal?.journalId ?? NONE } },
      summary: journal
        ? `Reverse ${journal.kind.toLowerCase()} journal ${journal.journalId} (${formatMoney(journal.amountMinor)}) with an equal and opposite entry`
        : 'Reverse a ledger journal',
    };
  },
  INITIATE_REFUND: (state) => {
    const gw = refundTarget(state);
    const refundable = gw && state.order ? refundableMinor(state.order, gw.id) : 0;
    const amountMinor = Math.max(1, refundable);
    return {
      action: { type: 'INITIATE_REFUND', params: { gwPaymentId: gw?.id ?? NONE, amountMinor, reason: refundReason(state) } },
      summary: gw ? `Refund ${formatMoney(amountMinor)} to the customer on ${gw.id}` : 'Refund the customer',
      editable: ['amountMinor', 'reason'],
      maxAmountMinor: refundable,
    };
  },
  SYNC_REFUND_STATUS: (state) => {
    const s = state.order;
    const refund = s?.refunds.find((r) => r.status !== 'PROCESSED' && r.gwRefundId) ?? s?.refunds[0];
    const gw = refund?.gwRefundId ? s?.gwRefunds.find((r) => r.id === refund.gwRefundId) : undefined;
    return {
      action: { type: 'SYNC_REFUND_STATUS', params: { refundId: refund?.id ?? NONE } },
      summary:
        refund && gw
          ? `Copy gateway status ${gw.status} of ${gw.id} to refund ${refund.id}${gw.status === 'PROCESSED' ? ' and post it to the ledger' : ''}`
          : 'Copy the gateway refund status to our refund record',
    };
  },
  RAISE_SETTLEMENT_DISPUTE: (state) => {
    const b = state.batch;
    const diff = b?.check.diffMinor ?? 0;
    const amountMinor = Math.max(1, Math.abs(diff));
    const batchId = b?.data.settlement.id ?? state.case.entityRefs.batchId ?? NONE;
    const gwPaymentId = b?.check.offendingLines[0]?.line.gwPaymentId;
    return {
      action: { type: 'RAISE_SETTLEMENT_DISPUTE', params: { batchId, amountMinor, ...(gwPaymentId ? { gwPaymentId } : {}) } },
      summary: diff !== 0 ? `Raise a dispute for ${formatMoney(amountMinor)} ${diff < 0 ? 'short' : 'over'} on batch ${batchId}` : `Raise a settlement dispute on batch ${batchId}`,
    };
  },
  HOLD_PAYMENT_FOR_REVIEW: (state) => {
    const p = state.order?.payment;
    return {
      action: { type: 'HOLD_PAYMENT_FOR_REVIEW', params: { paymentId: p?.id ?? NONE } },
      summary: p ? `Hold payment ${p.id} (${formatMoney(p.amountMinor)}) from payouts for review` : 'Hold the payment for review',
    };
  },
  ESCALATE_TO_HUMAN: (state) => ({
    action: { type: 'ESCALATE_TO_HUMAN', params: { reason: escalateReason(state), to: 'MANAGER' } },
    summary: `Escalate ${state.case.displayId} to a manager with the reason attached`,
    editable: ['reason'],
  }),
};

const replayFailedBefore = (history: readonly AttemptHistory[]) =>
  history.some(
    (h) => h.actionTypes.includes('REPLAY_WEBHOOK_EVENT') && (h.verdict === 'FAIL' || h.verdict === 'PARTIAL' || h.status === 'EXECUTION_FAILED'),
  );

/** The expected resolution for the case's shape (manual path; the agent decides for itself). */
export function recommendedTypes(state: CaseState, history: readonly AttemptHistory[] = []): ActionType[] {
  const s = state.order;
  switch (state.case.type) {
    case 'PAYMENT_MISMATCH': {
      if (!s || !isCaptured(s.primaryGw)) return ['ESCALATE_TO_HUMAN'];
      const needsLedger = captureCreditMinor(s) === 0;
      if (!PAID_ORDER_STATUSES.has(s.order.status) && s.order.status !== 'CANCELLED') {
        if (replayFailedBefore(history) || !replayCandidate(s)) {
          return needsLedger ? ['MARK_ORDER_PAID', 'POST_LEDGER_ENTRY'] : ['MARK_ORDER_PAID'];
        }
        return ['REPLAY_WEBHOOK_EVENT'];
      }
      return needsLedger ? ['POST_LEDGER_ENTRY'] : [];
    }
    case 'REFUND_EXCEPTION': {
      if (!s) return ['ESCALATE_TO_HUMAN'];
      const stuck = s.refunds.find((r) => r.status !== 'PROCESSED' && r.gwRefundId && s.gwRefunds.some((g) => g.id === r.gwRefundId && g.status !== 'PENDING'));
      if (stuck) return ['SYNC_REFUND_STATUS'];
      if (s.order.status === 'CANCELLED' && lastTransitionAt(s.order, 'CANCELLED')) return ['INITIATE_REFUND'];
      return ['ESCALATE_TO_HUMAN'];
    }
    case 'DUPLICATE':
      return ['INITIATE_REFUND'];
    case 'SETTLEMENT_MISMATCH':
      return ['RAISE_SETTLEMENT_DISPUTE'];
    case 'RISK_CASE':
      return ['HOLD_PAYMENT_FOR_REVIEW', 'ESCALATE_TO_HUMAN'];
  }
}

export function actionOptions(state: CaseState, history: readonly AttemptHistory[] = []): ActionOption[] {
  const recommended = new Set(recommendedTypes(state, history));
  return ACTION_TYPES.map((type) => {
    const draft = DRAFTERS[type](state);
    const failures = preconditionsOf(draft.action, state);
    const available = failures.length === 0;
    return {
      type,
      action: draft.action,
      summary: draft.summary,
      recommended: available && recommended.has(type),
      available,
      unavailableReason: available ? null : (missingSubject(draft.action) ?? failures[0] ?? `${ACTION_META[type].label} is not possible here.`),
      editable: draft.editable ?? [],
      maxAmountMinor: draft.maxAmountMinor ?? null,
    };
  });
}
