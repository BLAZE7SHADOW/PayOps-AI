/**
 * Agent-domain vocabulary shared by core (ports/adapters), agents (graph/state) and web (UI).
 * See docs/03-agent-system.md §4, §6, §7, §10, §16. Kept here so the graph state
 * (packages/agents/src/state.ts) is built from z.infer types instead of ad-hoc interfaces.
 */
import { z } from 'zod';
import type { CatalogAction } from './actions';
import type { PolicyDecision } from './policy';
import type { ActorRef, ExecutionStep, ValidationCheck, ValidationVerdict } from './dto/resolution';
import type { AmountBand } from './money';
import { SCENARIO_KEYS } from './scenarios';

// ── AI mode ──────────────────────────────────────────────────────────────────
export const AI_MODES = ['LIVE', 'RECORD', 'REPLAY'] as const;
export type AiMode = (typeof AI_MODES)[number];

// ── Run status ───────────────────────────────────────────────────────────────
export const RUN_STATUS = [
  'INVESTIGATING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VALIDATING',
  'RESOLVED',
  'ESCALATED',
  'REJECTED',
  'FAILED',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/** Investigation path actually taken for a run (docs/03 §4a). */
export const RUN_PATHS = ['FAST', 'FULL'] as const;
export type RunPath = (typeof RUN_PATHS)[number];

// ── Jev decision points (docs/03 §4) ────────────────────────────────────────
export const DECISION_TAGS = ['J1_INTAKE', 'J2_PLAN', 'J3_RISK', 'J4_GROUND', 'J5_REPLAN', 'J6_DIAGNOSE'] as const;
export type DecisionTag = (typeof DECISION_TAGS)[number];

// ── Root cause & finding vocabulary (docs/03 §10, §7) ───────────────────────
export const ROOT_CAUSES = [
  'WEBHOOK_PROCESSING_FAILURE',
  'WEBHOOK_NOT_DELIVERED',
  'ORDER_STATE_DIVERGED',
  'LEDGER_POSTING_MISSING',
  'DUPLICATE_CAPTURE',
  'REFUND_STATUS_NOT_SYNCED',
  'REFUND_NOT_INITIATED',
  'REFUND_FAILED_AT_GATEWAY',
  'SETTLEMENT_FEE_MISMATCH',
  'SETTLEMENT_LINE_MISSING',
  'SUSPECTED_FRAUD',
  'UNKNOWN',
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const FINDING_CODES = [
  'WEBHOOK_HTTP_500',
  'WEBHOOK_UNDELIVERED',
  'ORDER_STATE_DIVERGED',
  'LEDGER_CREDIT_MISSING',
  'DUPLICATE_CAPTURE_DETECTED',
  'REFUND_STATUS_MISMATCH',
  'REFUND_MISSING',
  'REFUND_FAILED',
  'SETTLEMENT_FEE_DIFF',
  'SETTLEMENT_LINE_MISSING',
  'RISK_SIGNAL',
  'OTHER',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** Evidence sources beyond the reconciliation systems (docs/03 §7). */
export const EVIDENCE_SYSTEMS = ['GATEWAY', 'ORDER', 'LEDGER', 'WEBHOOK', 'SETTLEMENT', 'REFUND', 'RISK'] as const;
export type EvidenceSystem = (typeof EVIDENCE_SYSTEMS)[number];

export const AGENT_NAMES = ['payment', 'reconciliation', 'risk'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

// ── Evidence & findings (docs/03 §7) ────────────────────────────────────────
export interface EvidenceItem {
  /** "ev_03" — short, stable within a run. */
  id: string;
  source: string;
  system: EvidenceSystem;
  entityRef: string;
  facts: Record<string, string | number | boolean>;
  observedAt: string;
  stepId: string;
}

export interface Finding {
  /** "fd_02" — short, stable within a run. */
  id: string;
  agent: AgentName;
  code: FindingCode;
  statement: string;
  evidenceIds: string[];
  confidence: number;
}

export interface GroundingViolation {
  findingId: string;
  reason: string;
}

export interface GroundingReport {
  checked: number;
  violations: GroundingViolation[];
  sufficient: boolean;
}

// ── Case brief (code-built, docs/03 §4a §8) ─────────────────────────────────
export interface CaseBrief {
  caseId: string;
  displayId: string;
  type: string;
  detectionRuleIds: string[];
  amountBand: AmountBand;
  mismatchedSystems: string[];
  flags: {
    hasRefund: boolean;
    hasSettlementBatch: boolean;
    isDuplicate: boolean;
    quarantinedText: boolean;
  };
}

export interface EntityRefs {
  paymentId?: string;
  gwPaymentId?: string;
  duplicateGwPaymentIds?: string[];
  orderId?: string;
  customerId?: string;
  merchantId?: string;
  refundId?: string;
  batchId?: string;
}

// ── Planning (Phase 4; kept for a stable state shape now) ───────────────────
export interface InvestigationPlan {
  primaryHypothesis: string;
  specialists: AgentName[];
  routedBy: 'JEV' | 'DEFAULT_ALL';
  confidence: number;
}

export interface EvidenceGap {
  agent: AgentName;
  reason: string;
}

// ── Risk (Phase 4; kept for a stable state shape now) ───────────────────────
export const RISK_TIERS_AGENT = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export interface RiskAssessment {
  tier: (typeof RISK_TIERS_AGENT)[number];
  scores: Record<string, number>;
  meanConfidence: number;
}

// ── Diagnosis & proposal ─────────────────────────────────────────────────────
export interface Diagnosis {
  rootCause: RootCause;
  narrative: string;
  confidence: number;
  supportingFindingIds: string[];
  path: RunPath;
}

export interface ResolutionProposal {
  actions: CatalogAction[];
  rationale: string;
  expectedPostconditions: string[];
}

// ── Approval / execution / validation (thin views over resolution.ts types) ─
export interface AgentApprovalDecision {
  approvalId: string;
  decision: 'APPROVE' | 'REJECT' | 'ESCALATE';
  decidedBy: ActorRef | null;
  comment: string | null;
}

export interface AttemptSummary {
  attempt: number;
  actions: CatalogAction[];
  failedChecks: string[];
  validatorNotes: string;
}

// ── Budget ───────────────────────────────────────────────────────────────────
export interface RunBudget {
  llmCalls: number;
  jevCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export const zeroBudget = (): RunBudget => ({ llmCalls: 0, jevCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
export const addBudgets = (a: RunBudget, b: RunBudget): RunBudget => ({
  llmCalls: a.llmCalls + b.llmCalls,
  jevCalls: a.jevCalls + b.jevCalls,
  toolCalls: a.toolCalls + b.toolCalls,
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  costUsd: a.costUsd + b.costUsd,
});

// ── Budget guard limits (docs/03 §2, §5) ────────────────────────────────────
export const AGENT_BUDGET_LIMITS = {
  maxFollowupToolCalls: 6,
  recursionLimit: 40,
  maxAttempts: 2,
} as const;

/**
 * Per-agent context token budgets (docs/03 §8 "Budgets"). Token counts are the chars/4 heuristic
 * documented in `packages/agents/src/context.ts` (see docs/DECISIONS.md D039), not an exact
 * tokenizer count — just enough to keep prompts bounded and comparable call to call. When a
 * built context exceeds its agent's budget, `applyBudget` (context.ts) drops sections in the
 * order the doc specifies: [5] history → [4] peer summaries → oldest evidence in [3].
 */
export const CONTEXT_BUDGET: Record<AgentName | 'resolve', number> = {
  payment: 1800,
  reconciliation: 1800,
  risk: 1200,
  resolve: 2200,
} as const;

// ── API DTOs (docs/02 §5) ───────────────────────────────────────────────────
export const CreateRunBody = z
  .object({
    /** For RECORD/REPLAY only: which cassette file to use (docs/03 §14). Ignored in LIVE. */
    scenarioKey: z.enum(SCENARIO_KEYS).optional(),
  })
  .strict()
  .optional()
  .default({});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

const cursorQuery = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const RunListQuery = z.object({
  ...cursorQuery,
  caseId: z.string().trim().min(1).max(64).optional(),
  status: z.enum(RUN_STATUS).optional(),
});
export type RunListQuery = z.infer<typeof RunListQuery>;

export interface AgentRunItem {
  id: string;
  caseId: string;
  resolutionId: string | null;
  status: RunStatus;
  path: RunPath | null;
  attempt: number;
  budget: RunBudget;
  diagnosis: Diagnosis | null;
  proposal: ResolutionProposal | null;
  policy: PolicyDecision | null;
  approvalId: string | null;
  executions: ExecutionStep[];
  validation: { verdict: ValidationVerdict; checks: ValidationCheck[] } | null;
  findings: Finding[];
  evidence: EvidenceItem[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const AGENT_STEP_KINDS = [
  'NODE_STARTED',
  'NODE_COMPLETED',
  'TOOL_CALLED',
  'TOOL_COMPLETED',
  'DECISION_MADE',
  'LLM_CALLED',
  'FINDING_CREATED',
  'PROPOSAL_CREATED',
  'POLICY_DECIDED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'EXECUTION_STEP',
  'VALIDATION_COMPLETED',
  'RUN_COMPLETED',
  'RUN_FAILED',
] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export interface AgentStepItem {
  id: string;
  runId: string;
  seq: number;
  node: string;
  kind: AgentStepKind;
  payload: Record<string, unknown>;
  at: string;
}

/** Payload shape published on every realtime run event (docs/03 §16). */
export interface RunEventEnvelope {
  runId: string;
  caseId: string;
  node: string;
  at: string;
  seq: number;
  data?: Record<string, unknown>;
}
