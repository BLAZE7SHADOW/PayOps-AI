import type { AgentStepItem, RunStatus } from '@payops/shared';
import { formatTime, statusLabel } from '../../lib/format';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { stepName } from './run-metrics';
import { buildRunFlow, FLOW_LABEL, NODE_LABEL, type NodeVisit } from './run-flow';

const STATE_TONE = { COMPLETED: 'ok', RUNNING: 'accent', WAITING: 'warn', PAUSED: 'neutral', FAILED: 'bad', STOPPED: 'neutral' } as const;

export function RunFlow({ steps, status }: { steps: AgentStepItem[] | undefined; status: RunStatus | undefined }) {
  if (!steps || !status) return <div className="space-y-3 rounded-lg border border-rule bg-surface p-5" aria-hidden="true">{[0, 1, 2].map((i) => <Skeleton key={i} height={76} width="100%" />)}</div>;
  const stages = buildRunFlow(steps, status);
  if (!stages.length) return <p className="rounded-lg border border-rule bg-surface px-5 py-4 text-14 text-ink-2">No run events recorded yet.</p>;

  return <div className="rounded-lg border border-rule bg-surface p-4 sm:p-6">
    <p className="mb-5 text-14 text-ink-2">Recorded path in execution order. Only agents and steps that ran appear here. Open a step to inspect its actions.</p>
    <ol className="space-y-0">
      {stages.map((stage, index) => <li key={`${stage.key}-${index}`} className="relative border-l-2 border-rule pb-5 pl-5 last:border-l-0 last:pb-0 sm:pl-7">
        <span aria-hidden="true" className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-accent bg-surface" />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-12 text-ink-2">{String(index + 1).padStart(2, '0')}</span>
          <h3 className="text-18 font-semibold text-ink">{FLOW_LABEL[stage.key]}</h3>
          <Tag tone={STATE_TONE[stage.state]}>{stage.state}</Tag>
        </div>
        <div className={stage.key === 'specialists' ? 'grid gap-2 lg:grid-cols-3' : 'grid gap-2'}>
          {stage.visits.map((visit, visitIndex) => <NodeCard key={`${visit.node}-${visitIndex}`} visit={visit} />)}
        </div>
      </li>)}
    </ol>
  </div>;
}

function NodeCard({ visit }: { visit: NodeVisit }) {
  const actions = visit.steps.filter((step) => !['NODE_STARTED', 'NODE_COMPLETED'].includes(step.kind));
  const tools = visit.steps.filter((step) => step.kind === 'TOOL_COMPLETED');
  const decisions = visit.steps.filter((step) => step.kind === 'DECISION_MADE');
  const findings = visit.steps.filter((step) => step.kind === 'FINDING_CREATED');
  const modelCalls = visit.steps.filter((step) => step.kind === 'LLM_CALLED');
  const skipped = visit.steps.some((step) => step.kind === 'NODE_COMPLETED' && step.payload.skipped === true);
  const metrics = [
    tools.length ? `${tools.length} tool ${tools.length === 1 ? 'result' : 'results'}` : null,
    decisions.length ? `${decisions.length} typed ${decisions.length === 1 ? 'decision' : 'decisions'}` : null,
    modelCalls.length ? `${modelCalls.length} model ${modelCalls.length === 1 ? 'call' : 'calls'}` : null,
    findings.length ? `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}` : null,
  ].filter(Boolean).join(' · ');

  return <details className="group min-w-0 rounded-md border border-rule bg-paper open:border-control">
    <summary className="cursor-pointer list-none px-4 py-2 marker:hidden hover:bg-surface-sunk">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{NODE_LABEL[visit.node] ?? visit.node}</span>
        <span className="flex items-center gap-2"><Tag tone={STATE_TONE[visit.state]}>{skipped ? 'SKIPPED' : visit.state}</Tag><span aria-hidden="true" className="text-ink-2">+</span></span>
      </span>
      <span className="mt-1 block text-12 text-ink-2">{skipped ? 'No applicable evidence for this specialist.' : metrics || (actions.length ? `${actions.length} recorded ${actions.length === 1 ? 'action' : 'actions'}` : 'No additional actions')}</span>
    </summary>
    <ol className="border-t border-rule px-4 py-2">
      {visit.steps.map((step) => <li key={step.seq} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-rule py-2 text-13 last:border-0">
        <div className="min-w-0"><span className="text-ink">{statusLabel(step.kind)}</span>{eventDetail(step) ? <span className="ml-2 font-mono text-12 break-all text-ink-2">{eventDetail(step)}</span> : null}
          {typeof step.payload.error === 'string' ? <p className="mt-1 text-bad">{step.payload.error}</p> : null}
          {Array.isArray(step.payload.evidenceIds) && step.payload.evidenceIds.length ? <p className="mt-1 font-mono text-12 text-ink-2">Evidence {step.payload.evidenceIds.join(', ')}</p> : null}
        </div>
        <time dateTime={step.at} className="tabular shrink-0 font-mono text-12 text-ink-2">{formatTime(step.at)}</time>
      </li>)}
    </ol>
  </details>;
}

function eventDetail(step: AgentStepItem): string {
  const name = stepName(step);
  if (name) return name;
  const payload = step.payload;
  if (Array.isArray(payload.findingIds)) return payload.findingIds.filter((id): id is string => typeof id === 'string').join(', ');
  if (step.kind === 'POLICY_DECIDED' && typeof payload.tier === 'string') return `${payload.tier} tier`;
  if (step.kind === 'VALIDATION_COMPLETED' && payload.validation && typeof payload.validation === 'object' && 'verdict' in payload.validation && typeof payload.validation.verdict === 'string') return payload.validation.verdict;
  if (step.kind === 'PROPOSAL_CREATED' && payload.proposal && typeof payload.proposal === 'object' && 'actions' in payload.proposal && Array.isArray(payload.proposal.actions)) {
    return payload.proposal.actions.map((action: unknown) => action && typeof action === 'object' && 'type' in action && typeof action.type === 'string' ? action.type : '').filter(Boolean).join(', ');
  }
  return '';
}
