/**
 * Builds the single "case story" shown on the Case page (D060) from records the API already returns:
 * run steps, findings, evidence, the resolution (policy, approval, executions, validation) and a
 * fresh read of the source records. Pure code, no model output: every actor label and status comes
 * from what was recorded, so an operator can cross-check each claim against its record.
 */
import {
  ACTION_META,
  DETECTION_RULE_LABEL,
  formatMoney,
  type AgentRunItem,
  type AgentStepItem,
  type CaseDetail,
  type CaseSourceRecords,
  type ExecutionRecordFact,
  type ResolutionItem,
} from '@payops/shared';
import { SYSTEM_LABEL } from '../../lib/status';
import { buildRunFlow, NODE_LABEL, type FlowState, type NodeVisit } from '../runs/run-flow';
import { nodeStory } from '../runs/run-story';

export type StoryActor = 'PERSON' | 'JEV' | 'GEMINI' | 'CODE';
export type StoryState = 'DONE' | 'RUNNING' | 'WAITING' | 'FAILED' | 'STOPPED';
export type GroundingStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCHECKED';

export interface StoryFact {
  evidenceId: string;
  /** "Gateway · gw_pay_9Kx2mQ4" */
  label: string;
  /** "status CAPTURED · amount ₹4,999.00" */
  summary: string;
}

export interface StoryFinding {
  id: string;
  statement: string;
  confidence: number;
  evidenceIds: string[];
  grounding: GroundingStatus;
  reason: string | null;
}

export type ApprovalState =
  | { status: 'AUTOMATIC' }
  | { status: 'WAITING'; role: 'OPS' | 'MANAGER' }
  | { status: 'APPROVED'; by: string; at: string }
  | { status: 'REJECTED'; by: string; at: string; comment: string | null }
  | { status: 'ESCALATED'; by: string; at: string }
  | { status: 'BLOCKED' };

export interface RecordChange {
  recordId: string;
  kind: string;
  system: string;
  label: string;
  before: string;
  after: string;
  isNew: boolean;
}

export interface StoryExecutionStep {
  index: number;
  label: string;
  status: string;
  summary: string;
  error: string | null;
  /** False for steps recorded before before-state capture existed (D060), so no comparison is shown. */
  hasBefore: boolean;
  changes: RecordChange[];
}

export interface StoryCheck {
  id: string;
  description: string;
  expected: string;
  actual: string;
  pass: boolean;
}

interface Base {
  key: string;
  number: number;
  actors: StoryActor[];
  /** Jev decision points used in this entry, e.g. "J2 plan". */
  jev: string[];
  title: string;
  summary: string;
  details: string[];
  state: StoryState;
  at: string | null;
}

export type StoryEntry = Base &
  (
    | { kind: 'detected' }
    | { kind: 'step'; node: string; facts: StoryFact[]; findings: StoryFinding[]; retries: string[] }
    | { kind: 'decision'; actions: string[]; expected: string[]; rationale: string; tier: string; tierReasons: string[]; approval: ApprovalState; earlierAttempts: number }
    | { kind: 'execution'; steps: StoryExecutionStep[]; readAt: string | null }
    | { kind: 'verification'; verdict: 'PASS' | 'PARTIAL' | 'FAIL'; checks: StoryCheck[] }
    | { kind: 'notStarted' }
    | { kind: 'running' }
    | { kind: 'outcome'; open: boolean }
  );

/** Omit that keeps each member of the union separate. */
type WithoutNumber<T> = T extends unknown ? Omit<T, 'number'> : never;

const ACTOR_ORDER: StoryActor[] = ['PERSON', 'JEV', 'GEMINI', 'CODE'];
const orderActors = (actors: Iterable<StoryActor>): StoryActor[] => {
  const set = new Set(actors);
  const ordered = ACTOR_ORDER.filter((actor) => set.has(actor));
  return ordered.length ? ordered : ['CODE'];
};

export const JEV_LABEL: Record<string, string> = {
  J1_INTAKE: 'J1 intake', J2_PLAN: 'J2 plan', J3_RISK: 'J3 risk',
  J4_GROUND: 'J4 grounding', J5_REPLAN: 'J5 replan', J6_DIAGNOSE: 'J6 diagnosis',
};

const EVIDENCE_SYSTEM_NAME: Record<string, string> = {
  GATEWAY: 'Gateway', ORDER: 'Order', LEDGER: 'Ledger', WEBHOOK: 'Webhook',
  SETTLEMENT: 'Settlement', REFUND: 'Refund', RISK: 'Risk signals',
};

const STEP_TITLE: Record<string, string> = {
  triage: 'Collected the first records',
  diagnose: 'Checked for a known pattern',
  plan: 'Chose where to look',
  paymentAgent: 'Checked payment and gateway records',
  reconciliationAgent: 'Compared ledger, webhook and settlement records',
  riskAgent: 'Reviewed risk signals',
  groundCheck: 'Checked findings against the evidence',
  replan: 'Chose how to recover',
};

/** Steps whose story is told by the decision, execution, verification and outcome entries instead. */
const HANDLED_ELSEWHERE = new Set([
  'loadCase', 'join', 'resolve', 'policyGate', 'awaitApproval', 'execute', 'validate',
  'closeResolved', 'closeBlocked', 'closeRejected', 'closeEscalated',
]);

export const FLOW_TO_STORY: Record<FlowState, StoryState> = {
  COMPLETED: 'DONE', RUNNING: 'RUNNING', WAITING: 'WAITING', PAUSED: 'WAITING', FAILED: 'FAILED', STOPPED: 'STOPPED',
};

const ACTIVE_RUN = new Set(['INVESTIGATING', 'EXECUTING', 'VALIDATING']);

function humanKey(key: string): string {
  return key.replace(/Minor$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function factValue(key: string, value: string | number | boolean): string {
  return key.endsWith('Minor') && typeof value === 'number' ? formatMoney(value) : String(value);
}

export function toFact(item: AgentRunItem['evidence'][number]): StoryFact {
  const name = EVIDENCE_SYSTEM_NAME[item.system] ?? item.system;
  const summary = Object.entries(item.facts).slice(0, 3).map(([key, value]) => `${humanKey(key)} ${factValue(key, value)}`).join(' · ');
  return { evidenceId: item.id, label: `${name} · ${item.entityRef}`, summary };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function visitActors(visit: NodeVisit): { actors: StoryActor[]; jev: string[] } {
  const actors = new Set<StoryActor>();
  const jev: string[] = [];
  for (const step of visit.steps) {
    if (step.kind === 'LLM_CALLED') actors.add('GEMINI');
    if (step.kind === 'DECISION_MADE') {
      actors.add('JEV');
      const tag = typeof step.payload.tag === 'string' ? step.payload.tag : '';
      const label = JEV_LABEL[tag] ?? (tag || 'Jev decision');
      if (!jev.includes(label)) jev.push(label);
    }
    if (step.kind === 'APPROVAL_RESOLVED') actors.add('PERSON');
  }
  return { actors: orderActors(actors), jev };
}

export function groundingFor(finding: AgentRunItem['findings'][number], run: AgentRunItem): { grounding: GroundingStatus; reason: string | null } {
  if (!run.grounding || run.grounding.needsHumanReview) return { grounding: 'UNCHECKED', reason: null };
  const violation = run.grounding.violations.find((v) => v.findingId === finding.id);
  return violation ? { grounding: 'UNSUPPORTED', reason: violation.reason } : { grounding: 'SUPPORTED', reason: null };
}

function stepEntry(visit: NodeVisit, run: AgentRunItem | undefined, index: number): Omit<Extract<StoryEntry, { kind: 'step' }>, 'number'> {
  const { actors, jev } = visitActors(visit);
  const evidence = run?.evidence ?? [];
  const evidenceIds = visit.steps.filter((s) => s.kind === 'TOOL_COMPLETED').flatMap((s) => stringList(s.payload.evidenceIds));
  const facts = [...new Set(evidenceIds)].flatMap((id) => {
    const item = evidence.find((e) => e.id === id);
    return item ? [toFact(item)] : [];
  });
  const findingIds = visit.steps.filter((s) => s.kind === 'FINDING_CREATED').flatMap((s) => stringList(s.payload.findingIds));
  const findings: StoryFinding[] = run ? run.findings.filter((f) => findingIds.includes(f.id)).map((f) => ({
    id: f.id, statement: f.statement, confidence: f.confidence, evidenceIds: f.evidenceIds, ...groundingFor(f, run),
  })) : [];
  const retries = visit.steps.filter((s) => s.kind === 'MODEL_RETRY').map((s) => {
    const p = s.payload;
    return `Retry ${String(p.attempt ?? '?')} of the ${String(p.provider ?? 'model')} call after: ${String(p.reason ?? 'a temporary error')}.`;
  });
  const story = nodeStory(visit, run);
  const summary = findings.length
    ? `Read ${facts.length} record${facts.length === 1 ? '' : 's'} and wrote ${findings.length} finding${findings.length === 1 ? '' : 's'}. Each finding lists the records it relies on.`
    : story.summary;
  const details = findings.length ? story.details.filter((d) => /^(Requested|Records checked)/.test(d)) : story.details;
  return {
    kind: 'step', node: visit.node, key: `step-${visit.node}-${index}`, actors, jev,
    title: STEP_TITLE[visit.node] ?? NODE_LABEL[visit.node] ?? visit.node,
    summary, details, state: FLOW_TO_STORY[visit.state], at: visit.startedAt, facts, findings, retries,
  };
}

function actionLabel(action: ResolutionItem['actions'][number]): string {
  const label = ACTION_META[action.type].label;
  const params = action.params as Record<string, unknown>;
  return typeof params.amountMinor === 'number' ? `${label} · ${formatMoney(params.amountMinor)}` : label;
}

function approvalState(r: Pick<ResolutionItem, 'policy' | 'approval'>): ApprovalState {
  if (r.policy.tier === 'AUTO') return { status: 'AUTOMATIC' };
  if (r.policy.tier === 'BLOCKED') return { status: 'BLOCKED' };
  const a = r.approval;
  if (!a || a.status === 'PENDING') return { status: 'WAITING', role: r.policy.tier };
  const by = a.decidedBy?.name ?? 'Unknown';
  const at = a.decidedAt ?? '';
  if (a.status === 'APPROVED') return { status: 'APPROVED', by, at };
  if (a.status === 'REJECTED') return { status: 'REJECTED', by, at, comment: a.comment };
  return { status: 'ESCALATED', by, at };
}

function describeChange(prev: ExecutionRecordFact, next: ExecutionRecordFact): [string, string] {
  const before: string[] = [];
  const after: string[] = [];
  if (prev.status !== next.status) { before.push(prev.status); after.push(next.status); }
  if (prev.amountMinor !== next.amountMinor) {
    before.push(prev.amountMinor === null ? 'no amount' : formatMoney(prev.amountMinor));
    after.push(next.amountMinor === null ? 'no amount' : formatMoney(next.amountMinor));
  }
  return [before.join(' · '), after.join(' · ')];
}

function changesBetween(before: ExecutionRecordFact[], after: ExecutionRecordFact[]): RecordChange[] {
  const prior = new Map(before.map((f) => [f.id, f]));
  const changes: RecordChange[] = [];
  for (const next of after) {
    const prev = prior.get(next.id);
    const label = `${next.kind} ${next.id}`;
    if (!prev) {
      const amount = next.amountMinor === null ? '' : ` · ${formatMoney(next.amountMinor)}`;
      changes.push({ recordId: next.id, kind: next.kind, system: next.system, label, before: 'none', after: `${next.status}${amount}`, isNew: true });
    } else if (prev.status !== next.status || prev.amountMinor !== next.amountMinor) {
      const [b, a] = describeChange(prev, next);
      changes.push({ recordId: next.id, kind: next.kind, system: next.system, label, before: b, after: a, isNew: false });
    }
  }
  return changes;
}

const asFacts = (records: CaseSourceRecords): ExecutionRecordFact[] => records.records.map((r) => ({
  system: r.system, kind: r.kind, id: r.id, status: r.status, amountMinor: r.amountMinor,
}));

function executionEntry(r: ResolutionItem, records: CaseSourceRecords | null): Omit<Extract<StoryEntry, { kind: 'execution' }>, 'number'> {
  const executed = r.executions.filter((s) => s.status !== 'SKIPPED');
  const steps: StoryExecutionStep[] = r.executions.map((s, i) => {
    // A step's "after" is the next step's "before"; the last step is compared with a fresh read.
    const next = r.executions[i + 1]?.before ?? (records ? asFacts(records) : null);
    const comparable = s.status === 'SUCCEEDED' && s.before !== null && next !== null;
    return {
      index: s.index, label: ACTION_META[s.type].label, status: s.status, summary: s.summary,
      error: s.error?.message ?? null, hasBefore: s.before !== null,
      changes: comparable ? changesBetween(s.before!, next!) : [],
    };
  });
  const failed = executed.some((s) => s.status === 'FAILED');
  const running = executed.some((s) => s.status === 'STARTED');
  return {
    kind: 'execution', key: 'execution', actors: ['CODE'], jev: [],
    title: failed ? 'The action failed' : running ? 'Running the action' : 'Applied the action',
    summary: failed
      ? 'The executor stopped at the first failed step. Nothing after it ran.'
      : running ? 'The executor is applying the permitted action.'
      : 'The executor applied the permitted action through fixed code. It does not use a model.',
    details: [], state: failed ? 'FAILED' : running ? 'RUNNING' : 'DONE',
    at: r.executions[0]?.startedAt ?? null, steps, readAt: records?.readAt ?? null,
  };
}

export interface StoryInput {
  c: CaseDetail;
  run: AgentRunItem | undefined;
  steps: AgentStepItem[];
  records: CaseSourceRecords | null | undefined;
}

export function buildCaseStory({ c, run, steps, records }: StoryInput): StoryEntry[] {
  const entries: Array<WithoutNumber<StoryEntry>> = [];
  const currentRecords = records ?? null;

  const labels = c.mismatched.map((s) => SYSTEM_LABEL[s]);
  entries.push({
    kind: 'detected', key: 'detected', actors: ['CODE'], jev: [], title: 'Detected a mismatch',
    summary: labels.length
      ? `${labels.join(', ')} ${labels.length === 1 ? 'does' : 'do'} not match the other systems for this payment.`
      : 'Detection rules flagged this payment.',
    details: c.ruleIds.map((id) => `Rule: ${DETECTION_RULE_LABEL[id] ?? id}`), state: 'DONE', at: c.openedAt,
  });

  const visits = run ? buildRunFlow(steps, run.status).flatMap((stage) => stage.visits) : [];
  visits.forEach((visit, i) => {
    if (!HANDLED_ELSEWHERE.has(visit.node)) entries.push(stepEntry(visit, run, i));
  });

  // Newest attempt first; the API does not promise an order.
  const resolutions = [...(c.resolutionView?.resolutions ?? [])].sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt));
  const latest = (run?.resolutionId ? resolutions.find((r) => r.id === run.resolutionId) : undefined) ?? resolutions[0];
  const resolveVisit = visits.find((v) => v.node === 'resolve');
  let approval: ApprovalState | null = null;

  const source = latest ?? (run?.proposal && run.policy ? { actions: run.proposal.actions, rationale: run.proposal.rationale, policy: run.policy, approval: null, proposedBy: { type: 'AGENT' as const } } : null);
  if (source) {
    approval = approvalState(source);
    const actors = new Set<StoryActor>(['CODE']);
    if (source.proposedBy.type === 'USER') actors.add('PERSON');
    else if (resolveVisit) visitActors(resolveVisit).actors.forEach((a) => actors.add(a));
    if (approval.status === 'APPROVED' || approval.status === 'REJECTED' || approval.status === 'ESCALATED') actors.add('PERSON');
    const jev = resolveVisit ? visitActors(resolveVisit).jev : [];
    if (jev.length) actors.add('JEV');
    const waiting = approval.status === 'WAITING';
    entries.push({
      kind: 'decision', key: 'decision', actors: orderActors(actors), jev,
      title: 'Proposed a fix and decided who must approve it',
      summary: `Proposed: ${source.actions.map(actionLabel).join('; ') || 'no action'}.`,
      details: [], state: waiting ? 'WAITING' : approval.status === 'BLOCKED' || approval.status === 'REJECTED' ? 'STOPPED' : 'DONE',
      at: latest?.createdAt ?? null,
      actions: source.actions.map(actionLabel),
      expected: run?.proposal?.expectedPostconditions ?? [],
      rationale: source.rationale,
      tier: source.policy.tier,
      tierReasons: source.policy.reasons.map((reason) => reason.reason),
      approval,
      earlierAttempts: Math.max(0, resolutions.length - 1),
    });
  }

  const hasExecution = latest ? latest.executions.length > 0 : false;
  if (latest && hasExecution) entries.push(executionEntry(latest, currentRecords));
  else if (approval && ['WAITING', 'BLOCKED', 'REJECTED', 'ESCALATED'].includes(approval.status)) {
    const why = approval.status === 'WAITING' ? 'These steps run after approval. Nothing has changed yet.'
      : approval.status === 'BLOCKED' ? 'Nothing was run. Policy blocked the action.'
      : approval.status === 'REJECTED' ? 'Nothing was run. The proposal was rejected.' : 'Nothing was run. The case was escalated.';
    entries.push({ kind: 'notStarted', key: 'not-started', actors: ['CODE'], jev: [], title: 'Execution and verification', summary: why, details: [], state: 'STOPPED', at: null });
  }

  if (latest?.validation) {
    const v = latest.validation;
    entries.push({
      kind: 'verification', key: 'verification', actors: ['CODE'], jev: [], title: 'Re-read the records and verified',
      summary: v.verdict === 'PASS' ? 'The validator read the records again instead of trusting the executor. Actual results match the expected results.'
        : v.verdict === 'FAIL' ? 'The validator read the records again and found the fix did not work.'
        : 'The validator read the records again and found the result needs review.',
      details: [], state: v.verdict === 'PASS' ? 'DONE' : v.verdict === 'FAIL' ? 'FAILED' : 'WAITING', at: v.at,
      verdict: v.verdict,
      checks: v.checks.map((k) => ({ id: k.id, description: k.description, expected: k.expected, actual: k.actual, pass: k.pass })),
    });
  }

  if (run && ACTIVE_RUN.has(run.status)) {
    entries.push({ kind: 'running', key: 'running', actors: ['CODE'], jev: [], title: 'Working', summary: 'Waiting for the next step to finish. New steps appear here as they complete.', details: [], state: 'RUNNING', at: null });
  } else {
    const waitingRole = approval?.status === 'WAITING' ? approval.role : null;
    const summary = c.status === 'RESOLVED' ? 'Closed after a verified resolution. No one needs to act.'
      : c.status === 'ESCALATED' ? 'Escalated for human review. A person needs to act.'
      : c.status === 'REJECTED' ? 'Closed after the proposal was rejected.'
      : c.status === 'AWAITING_APPROVAL' ? `Open. Waiting for ${waitingRole ?? 'an approver'} approval.`
      : c.status === 'EXECUTING' ? 'Open. The approved action is running.'
      : c.status === 'INVESTIGATING' ? 'Open. An investigation is running.'
      : 'Open. Needs an investigation or a manual resolution.';
    const open = !['RESOLVED', 'REJECTED'].includes(c.status);
    entries.push({
      kind: 'outcome', key: 'outcome', actors: ['CODE'], jev: [], title: open ? 'Case status' : 'Case closed', summary,
      details: c.status === 'RESOLVED' && c.resolution ? [c.resolution.summary] : [], state: open ? 'WAITING' : 'DONE', at: c.resolvedAt ?? null, open,
    });
  }

  return entries.map((entry, i) => ({ ...entry, number: i + 1 }) as StoryEntry);
}
