import type { ScenarioKey } from '@payops/shared';
import { capturedOrderFailed } from './captured-order-failed';
import { conflictingEvidence, misleadingNote } from './adversarial';
import { duplicateCapture } from './duplicate-capture';
import { healthyPayment } from './healthy-payment';
import { injectedRefundRequest } from './injected-refund-request';
import { refundNeverInitiated } from './refund-never-initiated';
import { refundStuck } from './refund-stuck';
import { replayFailsThenReplan } from './replay-fails-then-replan';
import { settlementMismatch } from './settlement-mismatch';
import { suspiciousPayment } from './suspicious-payment';
import { showcaseDuplicateCapture, showcaseLedgerGap, showcaseSettlementDispute, showcaseWebhookRecovery } from './showcase';
import {
  cancelRacedCapture,
  lateWebhookRetrying,
  partialRefundShortfall,
  partialRefundStuck,
  refundNeverReachedGateway,
  staleFailureAfterCapture,
} from './messy';
import type { ScenarioWriter } from './types';

export const SCENARIO_WRITERS: Record<ScenarioKey, ScenarioWriter> = {
  healthy_payment: healthyPayment,
  captured_order_failed: capturedOrderFailed,
  refund_stuck: refundStuck,
  refund_never_initiated: refundNeverInitiated,
  settlement_mismatch: settlementMismatch,
  duplicate_capture: duplicateCapture,
  suspicious_payment: suspiciousPayment,
  replay_fails_then_replan: replayFailsThenReplan,
  injected_refund_request: injectedRefundRequest,
  misleading_note: misleadingNote,
  conflicting_evidence: conflictingEvidence,
  showcase_webhook_recovery: showcaseWebhookRecovery,
  showcase_duplicate_capture: showcaseDuplicateCapture,
  showcase_settlement_dispute: showcaseSettlementDispute,
  showcase_ledger_gap: showcaseLedgerGap,
  late_webhook_retrying: lateWebhookRetrying,
  stale_failure_after_capture: staleFailureAfterCapture,
  partial_refund_stuck: partialRefundStuck,
  refund_never_reached_gateway: refundNeverReachedGateway,
  partial_refund_shortfall: partialRefundShortfall,
  cancel_raced_capture: cancelRacedCapture,
};
