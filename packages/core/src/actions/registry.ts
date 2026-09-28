import type {
  ActionOf,
  ActionType,
  CatalogAction,
  PreconditionFailure,
  ValidationCheck,
} from '@payops/shared';
import { escalate } from './handlers/escalate';
import { holdPayment } from './handlers/hold-payment';
import { initiateRefund } from './handlers/initiate-refund';
import { markOrderPaid } from './handlers/mark-order-paid';
import { postLedgerEntry } from './handlers/post-ledger-entry';
import { raiseSettlementDispute } from './handlers/raise-settlement-dispute';
import { replayWebhook } from './handlers/replay-webhook';
import { reverseLedgerEntry } from './handlers/reverse-ledger-entry';
import { syncRefundStatus } from './handlers/sync-refund-status';
import type { ActionHandler, CaseState, ExecContext, ExecOutcome } from './types';

/** One handler per catalog action. The mapped type makes a missing handler a compile error. */
export const ACTION_HANDLERS: { [K in ActionType]: ActionHandler<K> } = {
  REPLAY_WEBHOOK_EVENT: replayWebhook,
  MARK_ORDER_PAID: markOrderPaid,
  POST_LEDGER_ENTRY: postLedgerEntry,
  REVERSE_LEDGER_ENTRY: reverseLedgerEntry,
  INITIATE_REFUND: initiateRefund,
  SYNC_REFUND_STATUS: syncRefundStatus,
  RAISE_SETTLEMENT_DISPUTE: raiseSettlementDispute,
  HOLD_PAYMENT_FOR_REVIEW: holdPayment,
  ESCALATE_TO_HUMAN: escalate,
};

// TypeScript cannot correlate `action.type` with the handler's type parameter across a union,
// so dispatch goes through this one narrow cast.
function handlerFor<T extends ActionType>(action: ActionOf<T>): ActionHandler<T> {
  return ACTION_HANDLERS[action.type as T] as unknown as ActionHandler<T>;
}

export function preconditionsOf(action: CatalogAction, state: CaseState): string[] {
  return handlerFor(action).preconditions(action, state);
}

export function executeAction(action: CatalogAction, state: CaseState, ctx: ExecContext): Promise<ExecOutcome> {
  return handlerFor(action).execute(action, state, ctx);
}

export function postconditionsOf(action: CatalogAction, state: CaseState, index: number): ValidationCheck[] {
  return handlerFor(action).postconditions(action, state, index);
}

/** Every precondition failure of a proposal, evaluated on the same (current) state. */
export function checkPreconditions(actions: readonly CatalogAction[], state: CaseState): PreconditionFailure[] {
  return actions.flatMap((action, actionIndex) =>
    preconditionsOf(action, state).map((message) => ({ actionIndex, type: action.type, message })),
  );
}
