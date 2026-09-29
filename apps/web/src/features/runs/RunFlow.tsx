import type { AgentRunItem, AgentStepItem, RunStatus } from '@payops/shared';
import { formatTime, statusLabel } from '../../lib/format';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { stepName } from './run-metrics';
import { buildRunFlow, FLOW_LABEL, NODE_LABEL, type NodeVisit } from './run-flow';
import { nodeStory } from './run-story';

const STATE_TONE = { COMPLETED: 'ok', RUNNING: 'accent', WAITING: 'warn', PAUSED: 'neutral', FAILED: 'bad', STOPPED: 'neutral' } as const;

export function RunFlow({ steps, status, run }: { steps: AgentStepItem[] | undefined; status: RunStatus | undefined; run?: AgentRunItem }) {
  if (!steps || !status) return <div className="space-y-3 rounded-lg border border-rule bg-surface p-5" aria-hidden="true">{[0, 1, 2].map((i) => <Skeleton key={i} height={76} width="100%" />)}</div>;
  const stages = buildRunFlow(steps, status);
  if (!stages.length) return <p className="rounded-lg border border-rule bg-surface px-5 py-4 text-14 text-ink-2">No run events recorded yet.</p>;

  return <div className="rounded-lg border border-rule bg-surface p-4 sm:p-6">
    <p className="mb-5 text-14 text-ink-2">Follow each choice from the first records to the verified result. Selected specialists and extra records come from this run’s recorded decisions.</p>
    <ol className="space-y-0">
      {stages.map((stage, index) => <li key={`${stage.key}-${index}`} className="relative border-l-2 border-rule pb-5 pl-5 last:border-l-0 last:pb-0 sm:pl-7">
        <span aria-hidden="true" className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-accent bg-surface" />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-12 text-ink-2">{String(index + 1).padStart(2, '0')}</span>
          <h3 className="text-18 font-semibold text-ink">{FLOW_LABEL[stage.key]}</h3>
          <Tag tone={STATE_TONE[stage.state]}>{stage.state}</Tag>
        </div>
        <div className={stage.key === 'specialists' ? 'grid items-start gap-2 lg:grid-cols-3' : 'grid gap-2'}>
          {stage.visits.map((visit, visitIndex) => <NodeCard key={`${visit.node}-${visitIndex}`} visit={visit} run={run} />)}
        </div>
      </li>)}
    </ol>
  </div>;
}

function NodeCard({ visit, run }: { visit: NodeVisit; run?: AgentRunItem }) {
  const story = nodeStory(visit, run);
  const skipped = visit.steps.some((step) => step.kind === 'NODE_COMPLETED' && step.payload.skipped === true);
  const retries = visit.steps.filter((step) => step.kind === 'MODEL_RETRY');

  return <details className="group min-w-0 rounded-md border border-rule bg-paper open:border-control">
    <summary className="cursor-pointer list-none px-4 py-2 marker:hidden hover:bg-surface-sunk">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{NODE_LABEL[visit.node] ?? visit.node}</span>
        <span className="flex items-center gap-2"><Tag tone={STATE_TONE[visit.state]}>{skipped ? 'SKIPPED' : visit.state}</Tag><span aria-hidden="true" className="text-ink-2">+</span></span>
      </span>
      <span className="mt-1 block text-14 leading-5 text-ink-2">{story.summary}</span>
      {story.details[0] ? <span className="mt-1 block text-13 leading-5 text-ink">{story.details[0]}</span> : null}
      {retries.length ? <span className="mt-1 block text-13 text-warn">Temporary model issue: retried {retries.length} {retries.length === 1 ? 'time' : 'times'}.</span> : null}
    </summary>
    <div className="border-t border-rule px-4 py-3">
      {story.details.length > 1 ? <ul className="list-disc space-y-1 pl-5 text-14 text-ink">{story.details.slice(1).map((detail, i) => <li key={i}>{detail}</li>)}</ul> : <p className="text-13 text-ink-2">No further explanation was recorded for this step.</p>}
      <details className="mt-3 border-t border-rule pt-3">
        <summary className="cursor-pointer text-13 text-accent">Technical events</summary>
        <ol className="mt-2">
      {visit.steps.map((step) => <li key={step.seq} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-rule py-2 text-13 last:border-0">
        <div className="min-w-0"><span className="text-ink">{statusLabel(step.kind)}</span>{eventDetail(step) ? <span className="ml-2 font-mono text-12 break-all text-ink-2">{eventDetail(step)}</span> : null}
          {typeof step.payload.error === 'string' ? <p className="mt-1 text-bad">{step.payload.error}</p> : null}
          {Array.isArray(step.payload.evidenceIds) && step.payload.evidenceIds.length ? <p className="mt-1 font-mono text-12 text-ink-2">Evidence {step.payload.evidenceIds.join(', ')}</p> : null}
        </div>
        <time dateTime={step.at} className="tabular shrink-0 font-mono text-12 text-ink-2">{formatTime(step.at)}</time>
      </li>)}
        </ol>
      </details>
    </div>
  </details>;
}

function eventDetail(step: AgentStepItem): string {
  if (step.kind === 'MODEL_RETRY') return `${String(step.payload.provider)} · ${String(step.payload.reason).replaceAll('_', ' ')} · retry ${Number(step.payload.attempt) + 1}/${String(step.payload.maxAttempts)}`;
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
