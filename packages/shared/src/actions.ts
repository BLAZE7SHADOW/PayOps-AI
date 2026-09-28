/**
 * The closed action catalog (docs/03-agent-system.md §10).
 *
 * Every resolution, whether proposed by a person or by the agent, is a list of these actions.
 * Nothing outside this list can be executed. Parameters are validated with Zod; preconditions,
 * execution and postconditions live in packages/core (executor + validator).
 */
import { z } from 'zod';

export const ACTION_TYPES = [
  'REPLAY_WEBHOOK_EVENT',
  'MARK_ORDER_PAID',
  'POST_LEDGER_ENTRY',
  'REVERSE_LEDGER_ENTRY',
  'INITIATE_REFUND',
  'SYNC_REFUND_STATUS',
  'RAISE_SETTLEMENT_DISPUTE',
  'HOLD_PAYMENT_FOR_REVIEW',
  'ESCALATE_TO_HUMAN',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Action classes drive policy:
 * - STATE_CORRECTION: makes our internal records match what the gateway already did. No money moves.
 * - MONEY_MOVEMENT: moves customer or merchant money.
 * - CLAIM: raises a claim against a third party (acquirer / gateway).
 * - CONTROL: freezes or routes work to people.
 */
export const ACTION_CLASSES = ['STATE_CORRECTION', 'MONEY_MOVEMENT', 'CLAIM', 'CONTROL'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

const id = z.string().min(3).max(64);
const minor = z.number().int().positive().max(1_00_00_000_00); // ≤ ₹1 crore per action

export const ReplayWebhookParams = z.object({ eventId: id });
export const MarkOrderPaidParams = z.object({ orderId: id, paymentId: id });
export const PostLedgerEntryParams = z.object({ paymentId: id, amountMinor: minor });
export const ReverseLedgerEntryParams = z.object({ journalId: id });
export const InitiateRefundParams = z.object({
  gwPaymentId: id,
  amountMinor: minor,
  reason: z.string().trim().min(3).max(200),
});
export const SyncRefundStatusParams = z.object({ refundId: id });
export const RaiseSettlementDisputeParams = z.object({
  batchId: id,
  gwPaymentId: id.optional(),
  amountMinor: minor,
});
export const HoldPaymentParams = z.object({ paymentId: id });
export const EscalateParams = z.object({
  reason: z.string().trim().min(3).max(300),
  to: z.enum(['OPS', 'MANAGER']).default('MANAGER'),
});

export const CatalogAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REPLAY_WEBHOOK_EVENT'), params: ReplayWebhookParams }),
  z.object({ type: z.literal('MARK_ORDER_PAID'), params: MarkOrderPaidParams }),
  z.object({ type: z.literal('POST_LEDGER_ENTRY'), params: PostLedgerEntryParams }),
  z.object({ type: z.literal('REVERSE_LEDGER_ENTRY'), params: ReverseLedgerEntryParams }),
  z.object({ type: z.literal('INITIATE_REFUND'), params: InitiateRefundParams }),
  z.object({ type: z.literal('SYNC_REFUND_STATUS'), params: SyncRefundStatusParams }),
  z.object({ type: z.literal('RAISE_SETTLEMENT_DISPUTE'), params: RaiseSettlementDisputeParams }),
  z.object({ type: z.literal('HOLD_PAYMENT_FOR_REVIEW'), params: HoldPaymentParams }),
  z.object({ type: z.literal('ESCALATE_TO_HUMAN'), params: EscalateParams }),
]);
export type CatalogAction = z.infer<typeof CatalogAction>;
export type ActionOf<T extends ActionType> = Extract<CatalogAction, { type: T }>;

export interface ActionMeta {
  label: string;
  description: string;
  actionClass: ActionClass;
  moneyMoving: boolean;
  reversible: boolean;
}

export const ACTION_META: Record<ActionType, ActionMeta> = {
  REPLAY_WEBHOOK_EVENT: {
    label: 'Replay webhook event',
    description: 'Ask the gateway to deliver the event again so our consumer processes it.',
    actionClass: 'STATE_CORRECTION',
    moneyMoving: false,
    reversible: false,
  },
  MARK_ORDER_PAID: {
    label: 'Mark order paid',
    description: 'Move the order to PAID and link the captured payment.',
    actionClass: 'STATE_CORRECTION',
    moneyMoving: false,
    reversible: true,
  },
  POST_LEDGER_ENTRY: {
    label: 'Post capture to ledger',
    description: 'Post the missing capture journal for a payment the gateway captured.',
    actionClass: 'STATE_CORRECTION',
    moneyMoving: false,
    reversible: true,
  },
  REVERSE_LEDGER_ENTRY: {
    label: 'Reverse ledger journal',
    description: 'Post an equal and opposite journal. The original entry stays.',
    actionClass: 'STATE_CORRECTION',
    moneyMoving: false,
    reversible: false,
  },
  INITIATE_REFUND: {
    label: 'Refund customer',
    description: 'Create a refund at the gateway for a captured payment.',
    actionClass: 'MONEY_MOVEMENT',
    moneyMoving: true,
    reversible: false,
  },
  SYNC_REFUND_STATUS: {
    label: 'Sync refund status',
    description: 'Copy the gateway refund status to our refund record and post it to the ledger.',
    actionClass: 'STATE_CORRECTION',
    moneyMoving: false,
    reversible: false,
  },
  RAISE_SETTLEMENT_DISPUTE: {
    label: 'Raise settlement dispute',
    description: 'Open a dispute with the acquirer for the settlement shortfall.',
    actionClass: 'CLAIM',
    moneyMoving: false,
    reversible: false,
  },
  HOLD_PAYMENT_FOR_REVIEW: {
    label: 'Hold payment',
    description: 'Freeze the payment so it is excluded from payouts until reviewed.',
    actionClass: 'CONTROL',
    moneyMoving: false,
    reversible: true,
  },
  ESCALATE_TO_HUMAN: {
    label: 'Escalate',
    description: 'Route the case to a person with the reason attached.',
    actionClass: 'CONTROL',
    moneyMoving: false,
    reversible: true,
  },
};

/** Total money moved by a proposal, in paise. */
export function moneyMovingMinor(actions: readonly CatalogAction[]): number {
  return actions.reduce((sum, a) => (a.type === 'INITIATE_REFUND' ? sum + a.params.amountMinor : sum), 0);
}

/** Actions allowed when risk is CRITICAL (policy rule P1). */
export const CRITICAL_RISK_ALLOWED: readonly ActionType[] = ['HOLD_PAYMENT_FOR_REVIEW', 'ESCALATE_TO_HUMAN'];
