/** Wording sent to Jev with each Choice question. It is part of the cassette key, so changing a string needs a re-recording. */
import type { ReplanStrategy, RootCause } from '@payops/shared';

export const ROOT_CAUSE_CRITERIA: Record<RootCause, string> = {
  WEBHOOK_PROCESSING_FAILURE: 'A webhook for this payment was delivered but our consumer failed to process it (non-2xx response).',
  WEBHOOK_NOT_DELIVERED: 'A webhook for this payment was never delivered at all.',
  ORDER_STATE_DIVERGED: 'The gateway shows one state (e.g. captured) but our order record shows another.',
  LEDGER_POSTING_MISSING: 'The gateway captured the payment but no ledger credit was ever posted for it.',
  DUPLICATE_CAPTURE: 'More than one gateway capture exists for the same order.',
  REFUND_STATUS_NOT_SYNCED: 'The gateway refund status has moved on but our internal refund record still shows the old status.',
  REFUND_NOT_INITIATED: 'The order was cancelled or should be refunded, but no refund has been created yet.',
  REFUND_FAILED_AT_GATEWAY: 'A refund was attempted but the gateway reports it failed.',
  SETTLEMENT_FEE_MISMATCH: "The settlement batch's fees or net amount do not match what the ledger expects.",
  SETTLEMENT_LINE_MISSING: 'A settlement line the ledger expects for this batch is missing.',
  SUSPECTED_FRAUD: 'The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.',
  UNKNOWN: 'None of the above clearly explains this case from the facts given.',
};

/** J2's coarser five-way split, just enough to decide which specialists to run. */
export const PRIMARY_HYPOTHESIS_CRITERIA: Record<string, string> = {
  webhook_or_state_sync: 'A webhook was missed, failed or arrived late, so our order/payment state diverged from the gateway.',
  duplicate_capture: 'More than one gateway capture exists for the same order.',
  refund_lifecycle: 'A refund is missing, not yet initiated, stuck out of sync, or failed at the gateway.',
  settlement_reconciliation: "A settlement batch's fees or net amount do not match what the ledger expects.",
  fraud_or_abuse: 'The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.',
};

export const REPLAN_STRATEGY_CRITERIA: Record<ReplanStrategy, string> = {
  retry_same_action: 'The same action set should work if tried again -- the failure looks transient rather than a wrong choice.',
  alternative_action: 'A different action set from the catalog would fix this case instead of the one just tried.',
  reinvestigate: 'The diagnosis itself may be wrong; another investigation round is needed before proposing anything else.',
  escalate_to_human: 'This needs a person to review rather than another automatic attempt.',
};
