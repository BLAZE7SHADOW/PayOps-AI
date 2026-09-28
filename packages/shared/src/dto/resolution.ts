/** Phase 2 API contract: auth, manual resolution, approvals, executions, validation, policy. */
import { z } from 'zod';
import { CatalogAction, type ActionType } from '../actions';
import type { ActorType, CaseStatus, CaseType } from '../enums';
import type { PolicyDecision, PolicyRuleInfo, PolicyTier, ProposerType, RiskTier } from '../policy';
import type { CaseListItem } from './api';

// ── Auth ─────────────────────────────────────────────────────────────────────
export const DemoLoginBody = z.object({ email: z.email().transform((s) => s.toLowerCase()) });
export type DemoLoginBody = z.infer<typeof DemoLoginBody>;

// ── Action options (what the manual form can offer for a case) ───────────────
/**
 * Computed by core from the live case snapshot. `params` are prefilled; `editable` lists params the
 * user may change (for example a partial refund amount). Unavailable options explain why.
 */
export interface ActionOption {
  type: ActionType;
  /** Prefilled, valid parameters for this case. */
  action: CatalogAction;
  /** One-line, specific summary, e.g. "Replay payment.captured (evt_…) to our webhook consumer". */
  summary: string;
  recommended: boolean;
  available: boolean;
  unavailableReason: string | null;
  editable: Array<'amountMinor' | 'reason'>;
  /** Upper bound for editable amounts, e.g. refundable balance. */
  maxAmountMinor: number | null;
}

// ── Proposals ────────────────────────────────────────────────────────────────
export const ProposeActionsBody = z.object({
  actions: z.array(CatalogAction).min(1).max(6),
  rationale: z.string().trim().min(10).max(1000),
});
export type ProposeActionsBody = z.infer<typeof ProposeActionsBody>;

export const PreviewActionsBody = z.object({ actions: z.array(CatalogAction).min(1).max(6) });
export type PreviewActionsBody = z.infer<typeof PreviewActionsBody>;

export interface PreconditionFailure {
  actionIndex: number;
  type: ActionType;
  message: string;
}

export interface PolicyPreview {
  decision: PolicyDecision;
  preconditionFailures: PreconditionFailure[];
  /** Who could approve if approval is needed, e.g. "Another OPS user" / "A manager". */
  approverHint: string | null;
  attempt: number;
}

// ── Resolutions ──────────────────────────────────────────────────────────────
export const RESOLUTION_STATUS = [
  'BLOCKED',
  'AWAITING_APPROVAL',
  'REJECTED',
  'ESCALATED',
  'EXECUTING',
  'EXECUTION_FAILED',
  'VALIDATED',
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUS)[number];

export interface ActorRef {
  type: ActorType | ProposerType;
  id: string;
  name: string;
}

export type ExecutionStepStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface ExecutionStep {
  index: number;
  type: ActionType;
  status: ExecutionStepStatus;
  idempotencyKey: string;
  /** Plain-language outcome, e.g. "Gateway re-delivered payment.captured: consumer answered HTTP 409". */
  summary: string;
  error: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export type ValidationVerdict = 'PASS' | 'PARTIAL' | 'FAIL';

export interface ValidationCheck {
  id: string;
  /** e.g. "order.status" */
  subject: string;
  description: string;
  expected: string;
  actual: string;
  pass: boolean;
  /** Postcondition of a specific action, or a global invariant of the case. */
  kind: 'POSTCONDITION' | 'INVARIANT';
  actionIndex: number | null;
}

export interface ValidationResultDto {
  id: string;
  verdict: ValidationVerdict;
  checks: ValidationCheck[];
  at: string;
}

export interface ApprovalSummary {
  id: string;
  tier: Exclude<PolicyTier, 'AUTO' | 'BLOCKED'>;
  status: ApprovalStatus;
  decidedBy: ActorRef | null;
  comment: string | null;
  decidedAt: string | null;
}

export interface ResolutionItem {
  id: string;
  caseId: string;
  runId: string | null;
  attempt: number;
  status: ResolutionStatus;
  actions: CatalogAction[];
  rationale: string;
  proposedBy: ActorRef;
  policy: PolicyDecision;
  approval: ApprovalSummary | null;
  executions: ExecutionStep[];
  validation: ValidationResultDto | null;
  createdAt: string;
  updatedAt: string;
}

// ── Approvals ────────────────────────────────────────────────────────────────
export const APPROVAL_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'ESCALATED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const ApprovalListQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  scope: z.enum(['pending', 'decided', 'all']).default('pending'),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;

export interface ApprovalItem {
  id: string;
  case: { id: string; displayId: string; type: CaseType; status: CaseStatus; amountMinor: number };
  resolutionId: string;
  tier: Exclude<PolicyTier, 'AUTO' | 'BLOCKED'>;
  status: ApprovalStatus;
  /** e.g. "Refund customer ₹78,000.00" or "Hold payment · Escalate". */
  actionsSummary: string;
  actionTypes: ActionType[];
  moneyMovingMinor: number;
  riskTier: RiskTier;
  ruleIds: string[];
  requestedBy: ActorRef;
  requestedAt: string;
  decidedBy: ActorRef | null;
  decidedAt: string | null;
  comment: string | null;
  /** Evaluated for the current viewer: role and four-eyes. */
  canDecide: boolean;
  cannotDecideReason: string | null;
}

export interface ApprovalDetail extends ApprovalItem {
  resolution: ResolutionItem;
  caseItem: CaseListItem;
}

export const APPROVAL_DECISIONS = ['APPROVE', 'REJECT', 'ESCALATE'] as const;
export type ApprovalDecisionType = (typeof APPROVAL_DECISIONS)[number];

export const ApprovalDecisionBody = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    comment: z.string().trim().max(1000).default(''),
  })
  .refine((b) => b.decision === 'APPROVE' || b.comment.length >= 5, {
    message: 'A comment of at least 5 characters is required to reject or escalate',
    path: ['comment'],
  });
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBody>;

// ── Policy page ──────────────────────────────────────────────────────────────
export interface PolicyDocument {
  version: string;
  rules: readonly PolicyRuleInfo[];
  thresholds: Array<{ label: string; value: string }>;
  approverRoles: Array<{ tier: PolicyTier; approver: string }>;
}

// ── Case detail additions (served on GET /api/cases/:id) ─────────────────────
export interface CaseResolutionView {
  actionOptions: ActionOption[];
  resolutions: ResolutionItem[];
  /** Pending approval id if the case is waiting on a decision. */
  pendingApprovalId: string | null;
  /** Whether the viewer may propose a manual resolution now, and why not. */
  canPropose: boolean;
  cannotProposeReason: string | null;
}
