/**
 * Domain enums shared by api, worker, agents and web.
 * Each is a readonly tuple + derived union so it can feed both Zod and TypeScript.
 */

// ── External world (gateway) ─────────────────────────────────────────────────
export const GW_PAYMENT_STATUS = [
  'CREATED',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type GwPaymentStatus = (typeof GW_PAYMENT_STATUS)[number];

export const GW_REFUND_STATUS = ['PENDING', 'PROCESSED', 'FAILED'] as const;
export type GwRefundStatus = (typeof GW_REFUND_STATUS)[number];

export const WEBHOOK_EVENT_TYPES = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_DELIVERY_STATUS = ['DELIVERED', 'FAILED', 'PENDING'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUS)[number];

export const PAYMENT_METHODS = ['CARD', 'UPI', 'NETBANKING', 'WALLET'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CARD_NETWORKS = ['VISA', 'MASTERCARD', 'RUPAY', 'AMEX'] as const;
export type CardNetwork = (typeof CARD_NETWORKS)[number];

// ── Internal world ───────────────────────────────────────────────────────────
export const ORDER_STATUS = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'FULFILLED'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** Allowed order transitions. Anything else is rejected by OrderService. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PAID', 'FAILED', 'CANCELLED'],
  FAILED: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

export const INTERNAL_PAYMENT_STATUS = [
  'PENDING',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type InternalPaymentStatus = (typeof INTERNAL_PAYMENT_STATUS)[number];

export const REFUND_STATUS = ['REQUESTED', 'PENDING', 'PROCESSED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUS)[number];

export const LEDGER_ACCOUNTS = [
  'CUSTOMER_RECEIVABLE',
  'MERCHANT_PAYABLE',
  'FEES',
  'REFUNDS',
  'SETTLEMENT_CLEARING',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const LEDGER_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const LEDGER_SOURCES = ['SYSTEM', 'MANUAL', 'EXECUTOR'] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export const SETTLEMENT_STATUS = ['PENDING', 'MATCHED', 'MISMATCH'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[number];

export const NOTE_AUTHOR_TYPES = ['CUSTOMER', 'MERCHANT'] as const;
export type NoteAuthorType = (typeof NOTE_AUTHOR_TYPES)[number];

// ── Operations ───────────────────────────────────────────────────────────────
export const ROLES = ['VIEWER', 'OPS', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];
const ROLE_RANK: Record<Role, number> = { VIEWER: 0, OPS: 1, MANAGER: 2, ADMIN: 3 };
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export const SYSTEMS = ['GATEWAY', 'ORDER', 'LEDGER', 'WEBHOOK', 'SETTLEMENT'] as const;
export type SystemKey = (typeof SYSTEMS)[number];

export const CASE_TYPES = [
  'PAYMENT_MISMATCH',
  'REFUND_EXCEPTION',
  'SETTLEMENT_MISMATCH',
  'RISK_CASE',
  'DUPLICATE',
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  PAYMENT_MISMATCH: 'Payment mismatch',
  REFUND_EXCEPTION: 'Refund exception',
  SETTLEMENT_MISMATCH: 'Settlement mismatch',
  RISK_CASE: 'Risk review',
  DUPLICATE: 'Duplicate capture',
};

export const CASE_DISPLAY_PREFIX: Record<CaseType, 'PAY' | 'RFD' | 'STL' | 'RSK' | 'DUP'> = {
  PAYMENT_MISMATCH: 'PAY',
  REFUND_EXCEPTION: 'RFD',
  SETTLEMENT_MISMATCH: 'STL',
  RISK_CASE: 'RSK',
  DUPLICATE: 'DUP',
};

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const CASE_STATUS = [
  'OPEN',
  'INVESTIGATING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'RESOLVED',
  'ESCALATED',
  'REJECTED',
] as const;
export type CaseStatus = (typeof CASE_STATUS)[number];
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'ESCALATED',
];

export const DETECTION_RULES = [
  'D1_CAPTURED_NOT_PAID',
  'D2_PAID_NOT_CAPTURED',
  'D3_LEDGER_MISSING',
  'D4_DUPLICATE_CAPTURE',
  'D5_REFUND_PENDING_SLA',
  'D6_REFUND_MISSING',
  'D7_SETTLEMENT_DIFF',
  'D8_RISK_VELOCITY',
] as const;
export type DetectionRuleId = (typeof DETECTION_RULES)[number];

export const DETECTION_RULE_LABEL: Record<DetectionRuleId, string> = {
  D1_CAPTURED_NOT_PAID: 'Captured at gateway, order not paid',
  D2_PAID_NOT_CAPTURED: 'Order paid, gateway not captured',
  D3_LEDGER_MISSING: 'Captured payment has no ledger credit',
  D4_DUPLICATE_CAPTURE: 'More than one capture for an order',
  D5_REFUND_PENDING_SLA: 'Refund pending beyond SLA',
  D6_REFUND_MISSING: 'Cancelled order with captured payment and no refund',
  D7_SETTLEMENT_DIFF: 'Settlement net differs from ledger',
  D8_RISK_VELOCITY: 'High-value capture after repeated failures',
};

export const ACTOR_TYPES = ['USER', 'AGENT', 'SYSTEM'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
