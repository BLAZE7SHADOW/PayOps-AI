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
];
