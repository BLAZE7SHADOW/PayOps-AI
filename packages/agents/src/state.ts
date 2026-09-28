/**
 * LangGraph state (docs/03-agent-system.md §6). Kept small: raw tool payloads live in
 * `agent_steps` (Postgres via AgentStepLogger), state only holds `EvidenceItem` facts.
 * Every field from the doc's full shape is present, even where Phase 3 never writes it
 * (`plan`, `risk`, `grounding`, `history`), so Phase 4/5 nodes slot in without a state migration.
 */
import { Annotation } from '@langchain/langgraph';
import {
  addBudgets,
  zeroBudget,
  type AgentApprovalDecision,
  type AiMode,
  type AttemptSummary,
  type CaseBrief,
  type Diagnosis,
  type EntityRefs,
  type EvidenceGap,
  type EvidenceItem,
  type ExecutionStep,
  type Finding,
  type GroundingReport,
  type InvestigationPlan,
  type PolicyDecision,
  type ResolutionProposal,
  type RiskAssessment,
  type RunBudget,
  type RunStatus,
  type ValidationCheck,
  type ValidationVerdict,
} from '@payops/shared';

function mergeById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const byId = new Map(a.map((x) => [x.id, x]));
  for (const x of b) byId.set(x.id, x);
  return [...byId.values()];
}

export const PayOpsState = Annotation.Root({
  // identity
  caseId: Annotation<string>(),
  runId: Annotation<string>(),
  aiMode: Annotation<AiMode>(),
  scenarioKey: Annotation<string | undefined>({ reducer: (_, b) => b, default: () => undefined }),

  // case brief (built by code, compact, no raw docs)
  case: Annotation<CaseBrief | null>({ reducer: (_, b) => b, default: () => null }),
  entityRefs: Annotation<EntityRefs>({ reducer: (_, b) => b, default: () => ({}) }),

  // planning (Phase 4)
  plan: Annotation<InvestigationPlan | null>({ reducer: (_, b) => b, default: () => null }),
  investigationRound: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  gaps: Annotation<EvidenceGap[]>({ reducer: (_, b) => b, default: () => [] }),

  // evidence & findings (append-only, deduped by id)
  evidence: Annotation<EvidenceItem[]>({ reducer: mergeById, default: () => [] }),
  findings: Annotation<Finding[]>({ reducer: mergeById, default: () => [] }),
  agentsVisited: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),

  // assessments
  risk: Annotation<RiskAssessment | null>({ reducer: (_, b) => b, default: () => null }),
  grounding: Annotation<GroundingReport | null>({ reducer: (_, b) => b, default: () => null }),
  diagnosis: Annotation<Diagnosis | null>({ reducer: (_, b) => b, default: () => null }),
  proposal: Annotation<ResolutionProposal | null>({ reducer: (_, b) => b, default: () => null }),

  // control
  policy: Annotation<PolicyDecision | null>({ reducer: (_, b) => b, default: () => null }),
  approval: Annotation<AgentApprovalDecision | null>({ reducer: (_, b) => b, default: () => null }),
  resolutionId: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  approvalId: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  executions: Annotation<ExecutionStep[]>({ reducer: (_, b) => b, default: () => [] }),
  validation: Annotation<{ verdict: ValidationVerdict; checks: ValidationCheck[] } | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  attempt: Annotation<number>({ reducer: (_, b) => b, default: () => 1 }),
  history: Annotation<AttemptSummary[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),

  // accounting
  budget: Annotation<RunBudget>({ reducer: addBudgets, default: zeroBudget }),
  status: Annotation<RunStatus>({ reducer: (_, b) => b, default: (): RunStatus => 'INVESTIGATING' }),
  error: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
});

export type PayOpsStateType = typeof PayOpsState.State;
export type PayOpsUpdate = typeof PayOpsState.Update;
