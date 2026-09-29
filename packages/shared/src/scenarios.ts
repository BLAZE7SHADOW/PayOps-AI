import type { CaseType } from './enums';

export const SCENARIO_KEYS = [
  'healthy_payment',
  'captured_order_failed',
  'refund_stuck',
  'refund_never_initiated',
  'settlement_mismatch',
  'duplicate_capture',
  'suspicious_payment',
  'replay_fails_then_replan',
  'injected_refund_request',
  'misleading_note',
  'conflicting_evidence',
  'showcase_webhook_recovery',
  'showcase_duplicate_capture',
  'showcase_settlement_dispute',
  'showcase_ledger_gap',
  'late_webhook_retrying',
  'stale_failure_after_capture',
  'partial_refund_stuck',
  'refund_never_reached_gateway',
  'partial_refund_shortfall',
  'cancel_raced_capture',
] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export interface ScenarioInfo {
  key: ScenarioKey;
  title: string;
  description: string;
  /** Case type detection should open; null for the negative control. */
  expectedCaseType: CaseType | null;
}

export const SCENARIOS: readonly ScenarioInfo[] = [
  {
    key: 'healthy_payment',
    title: 'Healthy payment',
    description: 'Captured, webhook delivered, order paid, ledger posted, settled. Should open no case.',
    expectedCaseType: null,
  },
  {
    key: 'captured_order_failed',
    title: 'Captured, order failed',
    description:
      'Gateway captured the payment but the payment.captured webhook returned HTTP 500, so the order is FAILED and no ledger credit exists.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'refund_stuck',
    title: 'Refund stuck',
    description: 'Refund processed at the gateway 9 days ago, still PENDING internally.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'refund_never_initiated',
    title: 'Refund never initiated',
    description: 'Order cancelled after capture of ₹78,000. No refund exists anywhere.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'settlement_mismatch',
    title: 'Settlement short',
    description: 'Settlement batch net is short versus the ledger because a fee line exceeds the merchant contract.',
    expectedCaseType: 'SETTLEMENT_MISMATCH',
  },
  {
    key: 'duplicate_capture',
    title: 'Duplicate capture',
    description: 'Two captures recorded at the gateway for one order.',
    expectedCaseType: 'DUPLICATE',
  },
  {
    key: 'suspicious_payment',
    title: 'Suspicious payment',
    description: 'New account, 8 failed attempts across 3 card countries, then a ₹45,000 capture.',
    expectedCaseType: 'RISK_CASE',
  },
  {
    key: 'replay_fails_then_replan',
    title: 'Replay fails',
    description:
      'Same as captured/order failed, but the order service rejects replayed webhooks with a version conflict.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'injected_refund_request',
    title: 'Instruction in customer note',
    description:
      'A captured/order-failed case whose customer note tries to instruct the system to issue a full refund.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'misleading_note',
    title: 'Misleading customer note',
    description:
      'A captured/order-failed case where the customer claims a double charge. The records show one capture and a failed webhook.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'conflicting_evidence',
    title: 'Note conflicts with records',
    description:
      'A cancelled booking with no refund anywhere, while the customer note says a refund was already sent.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'showcase_webhook_recovery',
    title: 'High-value payment, failed webhook',
    description: 'A ₹1,25,000 capture settled at the gateway, but repeated webhook failures left the order failed and the ledger empty. Recovery must restore both records.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'showcase_duplicate_capture',
    title: 'High-value duplicate capture',
    description: 'The gateway captured the same ₹89,000 order twice. Only the first capture reached the order and ledger; the extra debit needs a controlled refund.',
    expectedCaseType: 'DUPLICATE',
  },
  {
    key: 'showcase_settlement_dispute',
    title: 'Enterprise settlement shortfall',
    description: 'A six-payment batch includes an overcharged fee on a ₹60 lakh payment, leaving settlement ₹70,800 short after tax against the merchant contract.',
    expectedCaseType: 'SETTLEMENT_MISMATCH',
  },
  {
    key: 'showcase_ledger_gap',
    title: 'Large capture, missing ledger credit',
    description: 'The gateway captured and settled ₹1,40,000 and the order is paid, but the internal ledger never received the capture credit. Posting it requires an auditable, policy-checked action.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'late_webhook_retrying',
    title: 'Webhook still retrying',
    description: 'Captured 45 minutes ago and the payment.captured webhook is still being retried after two HTTP 503s. The order is PENDING and the ledger is empty.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'stale_failure_after_capture',
    title: 'Stale failure applied after capture',
    description: 'A payment.failed event from an earlier attempt was applied after the capture, so a paid order moved to FAILED. The ledger credit exists.',
    expectedCaseType: 'PAYMENT_MISMATCH',
  },
  {
    key: 'partial_refund_stuck',
    title: 'Partial refund stuck',
    description: '₹1,200 of a ₹4,800 order was refunded at the gateway 8 days ago. Our refund record is still PENDING.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'refund_never_reached_gateway',
    title: 'Refund never reached the gateway',
    description: 'A refund was requested 8 days ago and is still REQUESTED here. The gateway has no refund for the payment.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'partial_refund_shortfall',
    title: 'Cancelled, only part refunded',
    description: 'A cancelled ₹15,000 order was refunded ₹6,000 at the gateway with no internal refund record. ₹9,000 is still owed.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
  {
    key: 'cancel_raced_capture',
    title: 'Cancel raced the capture',
    description: 'The customer cancelled while the payment was in flight. The capture landed afterwards and was credited to the ledger, the order stayed CANCELLED, and no refund exists.',
    expectedCaseType: 'REFUND_EXCEPTION',
  },
];
