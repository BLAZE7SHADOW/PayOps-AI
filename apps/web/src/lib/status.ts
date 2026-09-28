import type { CaseStatus, GwPaymentStatus, LedgerState, OrderStatus, Severity, SettlementState, SystemKey } from '@payops/shared';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent';

const GATEWAY: Record<GwPaymentStatus, Tone> = {
  CREATED: 'neutral',
  AUTHORIZED: 'warn',
  CAPTURED: 'ok',
  FAILED: 'bad',
  REFUNDED: 'neutral',
  PARTIALLY_REFUNDED: 'neutral',
};

const ORDER: Record<OrderStatus, Tone> = {
  PENDING: 'warn',
  PAID: 'ok',
  FAILED: 'bad',
  CANCELLED: 'neutral',
  FULFILLED: 'ok',
};

const INTERNAL: Record<string, Tone> = {
  PENDING: 'warn',
  CAPTURED: 'ok',
  FAILED: 'bad',
  REFUNDED: 'neutral',
  PARTIALLY_REFUNDED: 'neutral',
};

const LEDGER: Record<LedgerState, Tone> = { POSTED: 'ok', MISSING: 'bad', NOT_EXPECTED: 'neutral' };
const SETTLEMENT: Record<SettlementState, Tone> = { SETTLED: 'ok', PENDING: 'warn', MISMATCH: 'bad', NOT_EXPECTED: 'neutral' };

const CASE: Record<CaseStatus, Tone> = {
  OPEN: 'neutral',
  INVESTIGATING: 'accent',
  AWAITING_APPROVAL: 'warn',
  EXECUTING: 'accent',
  RESOLVED: 'ok',
  ESCALATED: 'bad',
  REJECTED: 'neutral',
};

const SEVERITY: Record<Severity, Tone> = { LOW: 'neutral', MEDIUM: 'neutral', HIGH: 'warn', CRITICAL: 'bad' };

export const tone = {
  gateway: (s: GwPaymentStatus): Tone => GATEWAY[s],
  order: (s: OrderStatus): Tone => ORDER[s],
  internal: (s: string): Tone => INTERNAL[s] ?? 'neutral',
  ledger: (s: LedgerState): Tone => LEDGER[s],
  settlement: (s: SettlementState): Tone => SETTLEMENT[s],
  caseStatus: (s: CaseStatus): Tone => CASE[s],
  severity: (s: Severity): Tone => SEVERITY[s],
};

export const SYSTEM_LABEL: Record<SystemKey, string> = {
  GATEWAY: 'Gateway',
  ORDER: 'Order',
  LEDGER: 'Ledger',
  WEBHOOK: 'Webhook',
  SETTLEMENT: 'Settlement',
};

export const SYSTEM_LETTER: Record<SystemKey, string> = {
  GATEWAY: 'G',
  ORDER: 'O',
  LEDGER: 'L',
  WEBHOOK: 'W',
  SETTLEMENT: 'S',
};
