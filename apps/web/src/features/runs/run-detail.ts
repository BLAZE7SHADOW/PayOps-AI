/**
 * Detailed, plain-English view of one agent run (D060 follow-up). For every step it answers:
 * what does this step do, was it fixed or chosen for this case, what did it call, what did it find,
 * why did it decide that, and what happens next. Pure code over recorded steps; no model output.
 */
import { ACTION_META, FAST_PATH, formatMoney, type AgentRunItem, type AgentStepItem } from '@payops/shared';
import { formatDecisionAnswer } from '../../lib/format';
import {
  FLOW_TO_STORY, JEV_LABEL, groundingFor, stringList, toFact, visitActors,
  type StoryActor, type StoryFact, type StoryFinding, type StoryState,
} from '../cases/case-story';
import { buildRunFlow, NODE_LABEL, type NodeVisit } from './run-flow';
import { nodeStory } from './run-story';

export type StepMode = 'FIXED' | 'DYNAMIC';
export interface CallDetail { kind: 'tools' | 'model' | 'jev'; title: string; lines: string[] }

export interface RunStepDetail {
  key: string;
  number: number;
  node: string;
  title: string;
  state: StoryState;
  at: string;
  durationMs: number | null;
  actors: StoryActor[];
  jev: string[];
  mode: StepMode;
  modeNote: string;
  purpose: string;
  calls: CallDetail[];
  found: string[];
  why: string[];
  facts: StoryFact[];
  findings: StoryFinding[];
  retries: string[];
  next: string | null;
  events: AgentStepItem[];
}

export interface RunOverview {
  path: 'FAST' | 'FULL' | null;
  specialists: Array<{ name: string; label: string; skipped: boolean }>;
  extraRounds: number;
  replans: number;
  lines: string[];
}

/** Mirrors the fast-path test in packages/agents/src/nodes.ts `diagnose`; keep the two in step. */

const HIDDEN_NODES = new Set(['loadCase', 'join']);

const SPECIALIST_LABEL: Record<string, string> = {
  payment: 'payment records', reconciliation: 'ledger, webhook and settlement records', risk: 'risk signals',
};
const SPECIALIST_NAME: Record<string, string> = { payment: 'Payment specialist', reconciliation: 'Reconciliation specialist', risk: 'Risk specialist' };
const SPECIALIST_NODE: Record<string, string> = { paymentAgent: 'payment', reconciliationAgent: 'reconciliation', riskAgent: 'risk' };

const TITLE: Record<string, string> = {
  triage: 'Collect the first records', diagnose: 'Check for a known pattern', plan: 'Choose where to look',
  paymentAgent: 'Payment specialist', reconciliationAgent: 'Reconciliation specialist', riskAgent: 'Risk specialist',
  groundCheck: 'Check findings against the evidence', resolve: 'Propose a fix', policyGate: 'Apply policy',
  awaitApproval: 'Wait for approval', execute: 'Run the action', validate: 'Verify the result', replan: 'Choose how to recover',
  closeResolved: 'Case resolved', closeBlocked: 'Stopped by policy', closeRejected: 'Proposal rejected', closeEscalated: 'Escalated to a person',
};

const PURPOSE: Record<string, string> = {
  triage: 'Reads a fixed set of baseline records (gateway payment, order, webhook deliveries, ledger entries and similar) so every case starts from the same minimum evidence. Fixed code, no model.',
  diagnose: 'Asks Jev whether the facts already point to one known cause. If it is confident enough, the run skips the model investigation and goes straight to a proposal.',
  plan: 'Asks Jev which specialists this case needs. A specialist that is not chosen never runs.',
  paymentAgent: 'Looks at the payment and gateway side. It may request extra records from a fixed list of read-only tools (capped), then Gemini writes findings that must cite evidence ids.',
  reconciliationAgent: 'Compares ledger, webhook and settlement records. It may request extra records from a fixed list of read-only tools (capped), then Gemini writes findings that must cite evidence ids.',
  riskAgent: 'Jev scores four risk signals (repeated attempts, identity mismatch, past customer flags, merchant disputes). If risk is elevated, Gemini may add a finding. It never authorizes an action.',
  groundCheck: 'Checks that every finding cites evidence that exists and supports it. If the evidence has gaps and the round limit is not reached, it sends the case back to Plan for a targeted extra round.',
  resolve: 'Turns the diagnosis into one proposed action from the fixed action catalog, with the result it expects.',
  policyGate: 'Fixed policy rules in code decide the tier: AUTO, OPS, MANAGER or BLOCKED. No model takes part in this decision.',
  awaitApproval: 'Pauses until a person with the right role approves, rejects or escalates the proposal.',
  execute: 'The executor applies the approved action through fixed code. Each action is idempotent, so running it twice changes nothing twice.',
  validate: 'The validator re-reads the records and checks what the action was expected to change. It does not trust the executor.',
  replan: 'Runs only when verification did not pass. Jev chooses whether to gather more evidence, retry, try another action, or hand the case to a person.',
  closeResolved: 'Ends the run after a verified fix.', closeBlocked: 'Ends the run because policy blocked the action.',
  closeRejected: 'Ends the run because an approver rejected the proposal.', closeEscalated: 'Ends the run and hands the case to a person.',
};

const pct = (n: unknown): string => (typeof n === 'number' ? `${Math.round(n * 100)}%` : 'unknown');
const words = (s: string): string => s.replace(/_/g, ' ');
const humanTool = (name: string): string => name.replace(/^get/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase() || name;
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);

interface Ctx {
  run: AgentRunItem;
  chosenSpecialists: string[];
  visits: NodeVisit[];
}

function completedPayload(visit: NodeVisit): Record<string, unknown> {
  return visit.steps.findLast((s) => s.kind === 'NODE_COMPLETED')?.payload ?? {};
}
const eventOf = (visit: NodeVisit, kind: AgentStepItem['kind']) => visit.steps.find((s) => s.kind === kind)?.payload;

function diagnoseFacts(visit: NodeVisit) {
  const answers = (eventOf(visit, 'DECISION_MADE')?.answers ?? {}) as Record<string, Record<string, unknown>>;
  const done = completedPayload(visit);
  return {
    path: done.path === 'FAST' ? ('FAST' as const) : ('FULL' as const),
    fallback: done.fallback === true,
    error: typeof done.error === 'string' ? done.error : null,
    rootCause: typeof done.rootCause === 'string' ? done.rootCause : null,
    confidence: typeof done.confidence === 'number' ? done.confidence : null,
    needsHuman: typeof answers.needs_human?.noul === 'number' ? answers.needs_human.noul : null,
    consistent: typeof answers.evidence_consistent?.noul === 'number' ? answers.evidence_consistent.noul : null,
  };
}

function unmetFastPath(d: ReturnType<typeof diagnoseFacts>): string[] {
  const unmet: string[] = [];
  if (d.confidence !== null && d.confidence < FAST_PATH.minConfidence) unmet.push(`confidence ${pct(d.confidence)} is below ${pct(FAST_PATH.minConfidence)}`);
  if (d.needsHuman !== null && d.needsHuman > FAST_PATH.maxNeedsHuman) unmet.push(`the "needs a person" score ${pct(d.needsHuman)} is above ${pct(FAST_PATH.maxNeedsHuman)}`);
  if (d.consistent !== null && d.consistent <= FAST_PATH.minConsistent) unmet.push(`the evidence-consistent score ${pct(d.consistent)} is not above ${pct(FAST_PATH.minConsistent)}`);
  return unmet;
}

function callsFor(visit: NodeVisit): CallDetail[] {
  const calls: CallDetail[] = [];
  for (const step of visit.steps) {
    const p = step.payload;
    if (step.kind === 'TOOL_COMPLETED') {
      const tools = stringList(p.tools).map(humanTool);
      const ids = stringList(p.evidenceIds);
      calls.push({ kind: 'tools', title: `Read ${tools.length} record source${tools.length === 1 ? '' : 's'} with code`, lines: [list(tools), ids.length ? `Produced evidence ${ids.join(', ')}` : 'Produced no new evidence'] });
    } else if (step.kind === 'LLM_CALLED') {
      const call = typeof p.call === 'string' ? p.call : '';
      const title = call === 'followUps' ? 'Asked Gemini which extra records to read'
        : call === 'findings' ? 'Asked Gemini to write findings from the records'
        : call === 'diagnosis' ? 'Asked Gemini to write the root-cause explanation' : 'Asked Gemini';
      const lines: string[] = [];
      if (call === 'followUps' && Array.isArray(p.followUps)) {
        for (const f of p.followUps) if (f && typeof f === 'object' && 'tool' in f) lines.push(`Suggested: ${humanTool(String((f as { tool: unknown }).tool))}`);
      }
      if (typeof p.contextTokenEstimate === 'number') lines.push(`About ${p.contextTokenEstimate.toLocaleString('en-IN')} tokens of context were sent.`);
      calls.push({ kind: 'model', title, lines });
    } else if (step.kind === 'DECISION_MADE') {
      const tag = typeof p.tag === 'string' ? p.tag : '';
      const answers = (p.answers ?? {}) as Record<string, unknown>;
      const lines = Object.entries(answers).map(([k, v]) => formatDecisionAnswer(k, v)).filter((x): x is string => x !== null);
      calls.push({ kind: 'jev', title: `Asked Jev (${JEV_LABEL[tag] ?? (tag || 'decision')})`, lines });
    }
  }
  return calls;
}

function foundFor(visit: NodeVisit, run: AgentRunItem, facts: StoryFact[], findings: StoryFinding[]): string[] {
  const done = completedPayload(visit);
  switch (visit.node) {
    case 'triage': return [`Collected ${facts.length} baseline record${facts.length === 1 ? '' : 's'}.`];
    case 'diagnose': {
      const d = diagnoseFacts(visit);
      if (d.fallback) return ['Jev did not answer, so no cause was suggested.'];
      return [`Jev's best guess: ${d.rootCause ? words(d.rootCause) : 'none'} at ${pct(d.confidence)} confidence.`, d.path === 'FAST' ? 'Result: fast path taken.' : 'Result: fast path not taken.'];
    }
    case 'plan': {
      const chosen = stringList(done.specialists).map((n) => SPECIALIST_LABEL[n] ?? n);
      return [`Selected: ${chosen.length ? list(chosen) : 'none'}.`, ...(typeof done.primaryHypothesis === 'string' ? [`Leading possibility: ${words(done.primaryHypothesis)}.`] : [])];
    }
    case 'paymentAgent':
    case 'reconciliationAgent':
      if (done.skipped === true) return ['No relevant records were available for this specialist, so it did nothing.'];
      if (done.fallback === true) return [`The specialist could not finish${typeof done.error === 'string' ? `: ${done.error}` : ''}.`];
      return [`Wrote ${findings.length} finding${findings.length === 1 ? '' : 's'}.`];
    case 'groundCheck': {
      const violations = asStrings(done.violations);
      const gaps = asStrings(done.gaps);
      return [violations.length ? `${violations.length} finding${violations.length === 1 ? '' : 's'} failed the evidence check.` : 'Every finding cites evidence that supports it.', ...(done.sufficient === false ? [`The evidence is not sufficient yet. Gaps: ${gaps.join(', ') || 'not listed'}.`] : [])];
    }
    case 'resolve': {
      const proposal = eventOf(visit, 'PROPOSAL_CREATED')?.proposal as { actions?: Array<{ type: keyof typeof ACTION_META; params?: Record<string, unknown> }>; rationale?: string; expectedPostconditions?: string[] } | undefined;
      if (!proposal?.actions) return nodeStoryLines(visit, run);
      const actions = proposal.actions.map((a) => {
        const amount = typeof a.params?.amountMinor === 'number' ? ` · ${formatMoney(a.params.amountMinor)}` : '';
        return `${ACTION_META[a.type]?.label ?? a.type}${amount}`;
      });
      return [`Proposed: ${actions.join('; ') || 'no action'}.`, ...(proposal.rationale ? [proposal.rationale] : []), ...(proposal.expectedPostconditions?.length ? [`Expected result: ${proposal.expectedPostconditions.join(' ')}`] : [])];
    }
    default: return nodeStoryLines(visit, run);
  }
}

function nodeStoryLines(visit: NodeVisit, run: AgentRunItem): string[] {
  const story = nodeStory(visit, run);
  return [story.summary, ...story.details];
}

function whyFor(visit: NodeVisit, ctx: Ctx): string[] {
  const done = completedPayload(visit);
  switch (visit.node) {
    case 'diagnose': {
      const d = diagnoseFacts(visit);
      if (d.fallback) return [`Jev could not be reached${d.error ? ` (${d.error})` : ''}, so the run falls back to the full investigation.`];
      const unmet = unmetFastPath(d);
      const rule = `The fast path needs confidence of at least ${pct(FAST_PATH.minConfidence)}, a "needs a person" score of ${pct(FAST_PATH.maxNeedsHuman)} or less, and evidence judged consistent.`;
      const seen = `This run: confidence ${pct(d.confidence)}, needs a person ${pct(d.needsHuman)}, evidence consistent ${pct(d.consistent)}.`;
      const outcome = d.path === 'FAST' ? 'All conditions were met, so the model investigation was skipped.' : unmet.length ? `A full investigation ran because ${list(unmet)}.` : 'A full investigation ran because the known pattern had no cited evidence to build on.';
      return [rule, seen, outcome];
    }
    case 'plan': {
      const lines: string[] = [];
      if (done.routedBy === 'GAP_TARGETED') lines.push(`The evidence check found gaps (${asStrings(done.gaps).join(', ')}), so only the specialists that can fill them were sent back.`);
      else if (done.routedBy === 'DEFAULT_ALL') lines.push('Jev did not answer, so every specialist was included.');
      else lines.push('Jev chose these specialists from the case type, detection rules and flags.');
      return lines;
    }
    case 'paymentAgent':
    case 'reconciliationAgent': {
      const asked = visit.steps.find((s) => s.kind === 'LLM_CALLED' && s.payload.call === 'followUps')?.payload.followUps;
      if (!Array.isArray(asked)) return [];
      const ran = new Set(visit.steps.filter((s) => s.kind === 'TOOL_COMPLETED').flatMap((s) => stringList(s.payload.tools)));
      return asked.flatMap((f: unknown) => {
        if (!f || typeof f !== 'object' || !('tool' in f) || !('reason' in f)) return [];
        const { tool, reason } = f as { tool: string; reason: string };
        return [ran.has(tool) ? `Read ${humanTool(tool)}: ${reason}` : `Suggested ${humanTool(tool)} but it was not run: ${reason}`];
      });
    }
    case 'riskAgent': return nodeStory(visit, ctx.run).details;
    case 'groundCheck': {
      const gaps = asStrings(done.gaps);
      return gaps.length ? [`Gaps found: ${gaps.join(', ')}.`] : [];
    }
    case 'policyGate': return asStrings(eventOf(visit, 'POLICY_DECIDED')?.reasons).length ? asStrings(eventOf(visit, 'POLICY_DECIDED')?.reasons) : [];
    case 'replan': {
      const strategy = typeof done.strategy === 'string' ? words(done.strategy) : null;
      if (!strategy) return [];
      return [`Jev chose "${strategy}"${typeof done.confidence === 'number' ? ` with ${pct(done.confidence)} confidence` : ''}.${done.fallback === true ? ' Jev could not be reached, so the case is handed to a person.' : ''}`];
    }
    default: return [];
  }
}

function modeFor(visit: NodeVisit, ctx: Ctx): { mode: StepMode; note: string } {
  const done = completedPayload(visit);
  const names = ctx.chosenSpecialists.map((n) => SPECIALIST_LABEL[n] ?? n);
  switch (visit.node) {
    case 'plan':
      return { mode: 'DYNAMIC', note: done.routedBy === 'GAP_TARGETED' ? `Extra round: evidence gaps (${asStrings(done.gaps).join(', ')}) sent the case back here.` : 'Runs when the fast path is not taken. The specialists it picks depend on this case.' };
    case 'paymentAgent': case 'reconciliationAgent': case 'riskAgent':
      return { mode: 'DYNAMIC', note: `Chosen by the Plan step for this case${names.length ? `: ${list(names)}` : ''}.${done.skipped === true ? ' It found no relevant records and did nothing.' : ''}` };
    case 'awaitApproval': return { mode: 'DYNAMIC', note: 'Only runs when policy requires a person to approve.' };
    case 'replan': return { mode: 'DYNAMIC', note: 'Only runs when verification did not pass.' };
    case 'groundCheck': return { mode: 'FIXED', note: 'Runs on every full investigation. Its result can add an extra round.' };
    case 'diagnose': return { mode: 'FIXED', note: 'Runs on every case. Its outcome decides whether a model investigation is needed.' };
    case 'execute': return { mode: 'FIXED', note: 'Runs when policy allows the action or after approval.' };
    case 'triage': return { mode: 'FIXED', note: 'Runs on every case.' };
    default: return { mode: 'FIXED', note: 'Always part of the flow at this point.' };
  }
}

function nextFor(visit: NodeVisit): string | null {
  const done = completedPayload(visit);
  switch (visit.node) {
    case 'triage': return 'Next: Check for a known pattern. This always follows the first records.';
    case 'diagnose': {
      const d = diagnoseFacts(visit);
      if (d.path === 'FAST') return 'Next: Propose a fix. Jev was confident enough to skip the model investigation.';
      const unmet = unmetFastPath(d);
      return `Next: Choose where to look (Plan). The fast path was not taken${d.fallback ? ' because Jev could not be reached' : unmet.length ? ` because ${list(unmet)}` : ''}.`;
    }
    case 'plan': {
      const names = stringList(done.specialists).map((n) => SPECIALIST_NAME[n] ?? n);
      return `Next: ${names.length ? list(names) : 'the chosen specialists'} run in parallel. Jev chose them for this case.`;
    }
    case 'paymentAgent': case 'reconciliationAgent': case 'riskAgent':
      return 'Next: Check findings against the evidence, once every chosen specialist has finished.';
    case 'groundCheck': {
      const gaps = asStrings(done.gaps);
      return gaps.length ? `Next: Choose where to look (Plan) again for a targeted extra round, because the evidence has gaps: ${gaps.join(', ')}.` : 'Next: Propose a fix. The evidence check found no gaps that need another round.';
    }
    case 'resolve': return 'Next: Apply policy to decide who, if anyone, must approve.';
    case 'policyGate': {
      const tier = eventOf(visit, 'POLICY_DECIDED')?.tier ?? done.tier;
      if (tier === 'AUTO') return 'Next: Execute. The AUTO tier needs no approval.';
      if (tier === 'BLOCKED') return 'Next: The run stops. Policy blocked the action.';
      return `Next: Wait for ${String(tier ?? 'an')} approval before anything changes.`;
    }
    case 'awaitApproval': {
      const d = eventOf(visit, 'APPROVAL_RESOLVED')?.decision;
      return d === 'APPROVE' ? 'Next: Execute the approved action.' : d === 'REJECT' ? 'Next: The run stops. The proposal was rejected.' : d ? 'Next: The run stops and a person takes over.' : 'Next: Continues after someone decides.';
    }
    case 'execute': return 'Next: Verify the result by re-reading the records.';
    case 'validate': {
      const v = eventOf(visit, 'VALIDATION_COMPLETED')?.validation as { verdict?: string; checks?: unknown[] } | undefined;
      if (v?.verdict === 'PASS') return `Next: Close the case as resolved. All ${v.checks?.length ?? 0} checks passed.`;
      if (v?.verdict) return 'Next: Replan. Verification did not pass, so the run chooses how to recover.';
      return null;
    }
    case 'replan': {
      const strategy = done.strategy;
      return strategy === 'reinvestigate' ? 'Next: Choose where to look (Plan) again to gather more evidence.'
        : strategy === 'retry_same_action' || strategy === 'alternative_action' ? 'Next: Propose a fix using the chosen approach.'
        : strategy === 'escalate_to_human' ? 'Next: The run stops and a person takes over.' : null;
    }
    default: return null;
  }
}

export function buildRunDetail(run: AgentRunItem, steps: AgentStepItem[]): { overview: RunOverview; steps: RunStepDetail[] } {
  const visits = buildRunFlow(steps, run.status).flatMap((stage) => stage.visits);
  const plans = visits.filter((v) => v.node === 'plan');
  const firstPlan = plans.find((v) => completedPayload(v).routedBy !== 'GAP_TARGETED') ?? plans[0];
  const chosenSpecialists = firstPlan ? stringList(completedPayload(firstPlan).specialists) : [];
  const ctx: Ctx = { run, chosenSpecialists, visits };

  const details: RunStepDetail[] = [];
  visits.forEach((visit, i) => {
    if (HIDDEN_NODES.has(visit.node)) return;
    const { actors, jev } = visitActors(visit);
    const evidenceIds = visit.steps.filter((s) => s.kind === 'TOOL_COMPLETED').flatMap((s) => stringList(s.payload.evidenceIds));
    const facts = [...new Set(evidenceIds)].flatMap((id) => { const item = run.evidence.find((e) => e.id === id); return item ? [toFact(item)] : []; });
    const findingIds = visit.steps.filter((s) => s.kind === 'FINDING_CREATED').flatMap((s) => stringList(s.payload.findingIds));
    const findings: StoryFinding[] = run.findings.filter((f) => findingIds.includes(f.id)).map((f) => ({
      id: f.id, statement: f.statement, confidence: f.confidence, evidenceIds: f.evidenceIds, ...groundingFor(f, run),
    }));
    const retries = visit.steps.filter((s) => s.kind === 'MODEL_RETRY').map((s) => `Retry ${String(s.payload.attempt ?? '?')} of the ${String(s.payload.provider ?? 'model')} call after: ${String(s.payload.reason ?? 'a temporary error').replace(/_/g, ' ')}.`);
    const first = Date.parse(visit.steps[0]?.at ?? '');
    const last = Date.parse(visit.steps.at(-1)?.at ?? '');
    const { mode, note } = modeFor(visit, ctx);
    details.push({
      key: `${visit.node}-${i}`, number: 0, node: visit.node, title: TITLE[visit.node] ?? NODE_LABEL[visit.node] ?? visit.node,
      state: FLOW_TO_STORY[visit.state], at: visit.startedAt, durationMs: Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null,
      actors, jev, mode, modeNote: note, purpose: PURPOSE[visit.node] ?? 'This step has no description yet. Open the technical events for details.',
      calls: callsFor(visit), found: foundFor(visit, run, facts, findings), why: whyFor(visit, ctx), facts, findings, retries,
      next: visit.node.startsWith('close') ? null : nextFor(visit), events: visit.steps,
    });
  });
  details.forEach((d, i) => { d.number = i + 1; });

  const diagnose = visits.find((v) => v.node === 'diagnose');
  const path = diagnose ? diagnoseFacts(diagnose).path : run.path === 'FAST' || run.path === 'FULL' ? run.path : null;
  const skipped = new Set(visits.filter((v) => completedPayload(v).skipped === true).map((v) => SPECIALIST_NODE[v.node]).filter((n): n is string => Boolean(n)));
  const specialists = chosenSpecialists.map((name) => ({ name, label: SPECIALIST_LABEL[name] ?? name, skipped: skipped.has(name) }));
  const extraRounds = plans.filter((v) => completedPayload(v).routedBy === 'GAP_TARGETED').length;
  const replans = visits.filter((v) => v.node === 'replan').length;
  const lines: string[] = [];
  if (path === 'FAST') lines.push('Fast path: Jev was confident enough, so the model investigation was skipped.');
  else if (path === 'FULL') lines.push('Full investigation: the fast path was not taken, so specialists gathered and checked evidence.');
  if (specialists.length) lines.push(`Specialists chosen for this case: ${list(specialists.map((s) => s.label))}.${specialists.some((s) => s.skipped) ? ` Did nothing: ${list(specialists.filter((s) => s.skipped).map((s) => s.label))}.` : ''}`);
  if (extraRounds) lines.push(`${extraRounds} extra evidence round${extraRounds === 1 ? '' : 's'} ran because the evidence check found gaps.`);
  if (replans) lines.push(`Verification failed ${replans} time${replans === 1 ? '' : 's'}, so the run replanned.`);
  return { overview: { path, specialists, extraRounds, replans, lines }, steps: details };
}
