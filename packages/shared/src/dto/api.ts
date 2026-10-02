import { z } from 'zod';
import {
  CASE_STATUS,
  CASE_TYPES,
  type ComplaintType,
  GW_PAYMENT_STATUS,
  ORDER_STATUS,
  ROLES,
  SEVERITIES,
  type ActorType,
  type CaseStatus,
  type CaseType,
  type DetectionRuleId,
  type GwPaymentStatus,
  type NoteAuthorType,
  type OrderStatus,
  type Role,
  type Severity,
  type SystemKey,
} from '../enums';
import { SCENARIO_KEYS, type ScenarioKey } from '../scenarios';
import type { CaseResolutionView, ValidationVerdict } from './resolution';

// ── Envelope types ───────────────────────────────────────────────────────────
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

const cursorQuery = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

// ── Auth ─────────────────────────────────────────────────────────────────────
export const LoginBody = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBody>;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface DemoAccount {
  email: string;
  name: string;
  role: Role;
  label: string;
}

export const RoleSchema = z.enum(ROLES);

// ── Payments ─────────────────────────────────────────────────────────────────
export const PaymentListQuery = z.object({
  ...cursorQuery,
  q: z.string().trim().max(64).optional(),
  gatewayStatus: z.enum(GW_PAYMENT_STATUS).optional(),
  orderStatus: z.enum(ORDER_STATUS).optional(),
  mismatchOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type PaymentListQuery = z.infer<typeof PaymentListQuery>;

export type LedgerState = 'POSTED' | 'MISSING' | 'NOT_EXPECTED';
export type SettlementState = 'SETTLED' | 'PENDING' | 'MISMATCH' | 'NOT_EXPECTED';

export interface PaymentListItem {
  paymentId: string;
  gwPaymentId: string;
  orderId: string;
  createdAt: string;
  customer: { id: string; name: string; emailMasked: string };
  merchant: { id: string; name: string };
  amountMinor: number;
  method: string;
  gatewayStatus: GwPaymentStatus;
  internalStatus: string;
  orderStatus: OrderStatus;
  ledger: LedgerState;
  settlement: SettlementState;
  mismatch: boolean;
  openCase: { id: string; displayId: string } | null;
}

export type LifecycleTone = 'ok' | 'bad' | 'warn' | 'neutral';

export interface LifecycleEvent {
  at: string;
  system: SystemKey | 'REFUND' | 'RISK';
  title: string;
  detail?: string;
  tone: LifecycleTone;
}

export interface PaymentDetail extends PaymentListItem {
  card: { last4: string; network: string; country: string } | null;
  lifecycle: LifecycleEvent[];
  matrix: StateMatrix;
}

// ── State matrix ─────────────────────────────────────────────────────────────
export interface MatrixCell {
  system: SystemKey;
  /** Display code, e.g. CAPTURED, FAILED, MISSING, "HTTP 500". */
  status: string | null;
  amountMinor: number | null;
  at: string | null;
  detail: string | null;
  mismatch: boolean;
  /** The gateway is the reference system for money movement. */
  reference: boolean;
}

export interface StateMatrix {
  cells: Record<SystemKey, MatrixCell>;
  mismatched: SystemKey[];
}

// ── Cases ────────────────────────────────────────────────────────────────────
export const CaseListQuery = z.object({
  ...cursorQuery,
  status: z.enum(CASE_STATUS).optional(),
  type: z.enum(CASE_TYPES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  scope: z.enum(['open', 'closed', 'all']).default('open'),
  /** A user id, or `unassigned`. */
  assigneeId: z.string().min(1).max(64).optional(),
  /** `true` keeps only open cases past their due time. */
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  /** Display id (PAY-0042), case id, payment id or order id. Prefix match, case-insensitive. */
  q: z.string().trim().min(1).max(64).optional(),
});
export type CaseListQuery = z.infer<typeof CaseListQuery>;

export const AssignCaseBody = z.object({ assigneeId: z.string().min(1).max(64).nullable() });
export type AssignCaseBody = z.infer<typeof AssignCaseBody>;

export interface CaseSignals {
  complaintType?: ComplaintType;
  urgent?: boolean;
  quarantined?: boolean;
}

export interface CaseListItem {
  id: string;
  displayId: string;
  type: CaseType;
  severity: Severity;
  priority: number;
  status: CaseStatus;
  amountMinor: number;
  ruleIds: DetectionRuleId[];
  mismatched: SystemKey[];
  signals: CaseSignals;
  openedAt: string;
  updatedAt: string;
  assignee: { id: string; name: string } | null;
  /** When the case must be acted on by (SLA by severity). Null only for cases opened before D067. */
  dueAt: string | null;
  /** Open and past `dueAt`, computed by the server. */
  overdue: boolean;
  primaryRef: { paymentId?: string; orderId?: string; batchId?: string };
}

export interface CaseNote {
  id: string;
  authorType: NoteAuthorType;
  text: string;
  quarantined: boolean;
  at: string;
}

export interface CaseDetail extends CaseListItem {
  matrix: StateMatrix;
  entityRefs: {
    paymentId?: string;
    gwPaymentId?: string;
    orderId?: string;
    customerId?: string;
    merchantId?: string;
    refundId?: string;
    batchId?: string;
  };
  customer: { id: string; name: string; emailMasked: string } | null;
  merchant: { id: string; name: string } | null;
  notes: CaseNote[];
  lifecycle: LifecycleEvent[];
  resolvedAt: string | null;
  resolution: { by: ActorType; summary: string } | null;
  /** Manual resolution context and history (Phase 2). */
  resolutionView: CaseResolutionView;
}

/** Fresh, read-only projections of the records behind a case, independent of agent findings. */
export interface CaseSourceRecord {
  system: SystemKey | 'REFUND' | 'DISPUTE';
  kind: string;
  id: string;
  status: string;
  amountMinor: number | null;
  at: string | null;
  details: Array<{ label: string; value: string }>;
}

export interface CaseSourceRecords {
  caseId: string;
  readAt: string;
  records: CaseSourceRecord[];
}

// ── Overview ─────────────────────────────────────────────────────────────────
export interface OverviewMetrics {
  capturedTodayMinor: number;
  capturedTodayCount: number;
  openExceptions: number;
  awaitingApproval: number;
  resolved7d: number;
  resolvedByAgent7d: number;
  /** Validator verdicts recorded in the last 7 days (one row per verification, so a replanned case counts each attempt). */
  validatorOutcomes7d: Record<ValidationVerdict, number>;
  exceptionsByType: Array<{ date: string } & Partial<Record<CaseType, number>>>;
  oldestOpen: CaseListItem[];
}

// ── Simulator ────────────────────────────────────────────────────────────────
export const GenerateScenarioBody = z.object({
  scenario: z.enum(SCENARIO_KEYS),
  seed: z.coerce.number().int().min(0).max(2 ** 31).optional(),
  /** Healthy background payments generated alongside the scenario. */
  noise: z.coerce.number().int().min(0).max(50).default(0),
});
export type GenerateScenarioBody = z.infer<typeof GenerateScenarioBody>;

export interface GenerateScenarioResult {
  scenario: ScenarioKey;
  seed: number;
  created: { paymentIds: string[]; orderIds: string[]; batchIds: string[] };
  casesOpened: Array<{ id: string; displayId: string; type: CaseType }>;
}

// ── Audit ────────────────────────────────────────────────────────────────────
export const AuditListQuery = z.object({
  ...cursorQuery,
  caseId: z.string().trim().min(1).max(64).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

export interface AuditEventItem {
  id: string;
  at: string;
  actorType: ActorType;
  actor: { id: string; name: string };
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  runId: string | null;
}
/** Result of walking the hash chain (P4 task 3, D077). `head` is the newest verified link; keep it outside the database to detect a cut tail. */
export interface AuditChainStatus {
  ok: boolean;
  checked: number;
  head: { seq: number; hash: string } | null;
  brokenAtSeq: number | null;
  brokenId: string | null;
  reason: 'HASH_MISMATCH' | 'PREV_MISMATCH' | 'SEQ_GAP' | 'TRUNCATED' | null;
}

