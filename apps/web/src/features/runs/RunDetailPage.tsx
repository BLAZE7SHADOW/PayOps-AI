import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AgentRunItem, AgentStepItem } from '@payops/shared';
import { formatDateTime, formatFullDateTime, statusLabel } from '../../lib/format';
import { useDocumentTitle } from '../../lib/use-document-title';
import { ErrorState } from '../../ui/ErrorState';
import { PageHeader } from '../../ui/PageHeader';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { useRunSteps } from '../investigation/api';
import { useRun } from './api';
import { RunFlow } from './RunFlow';
import { RUN_TONE, contextTokens, formatCost, formatDuration, nodeLatencies, runDurationMs, stepDeltas, stepName } from './run-metrics';

export function RunDetailPage() {
  const { runId = '' } = useParams();
  useDocumentTitle(`Run ${runId}`);
  const run = useRun(runId);
  const steps = useRunSteps(run.data);

  if (run.isError) {
    return (
      <div className="border border-rule bg-surface">
        <ErrorState title="Could not load this run." error={run.error} onRetry={() => void run.refetch()} />
      </div>
    );
  }
  const r = run.data;
  const items = steps.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Investigation run"
        meta={
          r ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Tag tone={RUN_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</Tag>
              <span className="font-mono text-12 text-ink-2">{runId}</span>
              <span>
                Case{' '}
                <Link to={`/cases/${r.caseId}`} className="link font-mono text-12">
                  {r.caseId}
                </Link>
              </span>
              <time dateTime={r.createdAt} title={formatFullDateTime(r.createdAt)} className="tabular font-mono text-12">
                {formatDateTime(r.createdAt)}
              </time>
            </span>
          ) : (
            ' '
          )
        }
        actions={
          <span className="flex flex-wrap gap-4 text-13">
            {r ? <><Link to={`/cases/${r.caseId}#source-records`} className="link">Check source records</Link><Link to={`/audit?caseId=${encodeURIComponent(r.caseId)}`} className="link">Case audit trail</Link></> : null}
            <Link to="/runs" className="link">All runs</Link>
          </span>
        }
      />
      <section aria-labelledby="flow-title">
        <h2 id="flow-title" className="mb-3 text-20 font-semibold">What happened</h2>
        {steps.isError ? <ErrorState title="Could not load run steps." error={steps.error} onRetry={() => void steps.refetch()} /> : <RunFlow steps={steps.isPending ? undefined : items} status={r?.status} run={r} />}
      </section>
      <section aria-labelledby="usage-title" className="mt-8">
        <h2 id="usage-title" className="mb-3 text-18 font-semibold">Run usage</h2>
        <Figures run={r} />
      </section>
      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-12">
        <section aria-labelledby="latency-title" className="min-w-0 xl:col-span-5">
          <h2 id="latency-title" className="flex h-10 items-center text-18 font-semibold">
            Time per node
          </h2>
          <div className="border border-rule bg-surface px-4 py-3">
            <NodeLatency steps={steps.isPending ? undefined : items} />
          </div>
        </section>
        <section aria-labelledby="steps-title" className="min-w-0 xl:col-span-7">
          <h2 id="steps-title" className="flex h-10 items-center text-18 font-semibold">
            Recorded events
          </h2>
          <StepTable steps={steps.isPending ? undefined : items} />
        </section>
      </div>
    </>
  );
}

function Figures({ run }: { run: AgentRunItem | undefined }) {
  const cells: Array<[string, string | undefined]> = run
    ? [
        ['Duration', formatDuration(runDurationMs(run, Date.now()))],
        ['Attempts', String(run.attempt)],
        ['LLM calls', String(run.budget.llmCalls)],
        ['Jev calls', String(run.budget.jevCalls)],
        ['Tool calls', String(run.budget.toolCalls)],
        ['Tokens', (run.budget.tokensIn + run.budget.tokensOut).toLocaleString('en-IN')],
        ['Cost', formatCost(run.budget.costUsd)],
      ]
    : ['Duration', 'Attempts', 'LLM calls', 'Jev calls', 'Tool calls', 'Tokens', 'Cost'].map((l) => [l, undefined]);
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-rule bg-surface sm:grid-cols-4 xl:grid-cols-7">
      {cells.map(([label, value], i) => (
        <div key={label} className={`${i ? 'border-l border-rule' : ''} border-b border-rule px-4 py-3 xl:border-b-0`}>
          <dt className="text-12 text-ink-2">{label}</dt>
          <dd className="tabular mt-1 flex h-7 items-center font-mono text-20 font-medium text-ink">
            {value ?? <Skeleton width={48} height={18} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NodeLatency({ steps }: { steps: AgentStepItem[] | undefined }) {
  if (!steps) {
    return (
      <ul aria-hidden="true" className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="flex h-6 items-center">
            <Skeleton width="100%" height={10} />
          </li>
        ))}
      </ul>
    );
  }
  const rows = nodeLatencies(steps);
  if (!rows.length) return <p className="text-13 text-ink-2">No completed nodes yet.</p>;
  const max = Math.max(...rows.map((r) => r.ms), 1);
  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ node, ms }) => (
        <li key={node}>
          <div className="flex items-baseline justify-between text-12">
            <span className="font-mono text-ink">{node}</span>
            <span className="tabular font-mono text-ink-2">{formatDuration(ms)}</span>
          </div>
          <div className="mt-1 h-1.5 bg-surface-sunk" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${(ms / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function StepTable({ steps }: { steps: AgentStepItem[] | undefined }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });

  if (!steps) {
    return (
      <div className="border border-rule bg-surface" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-9 items-center border-b border-rule px-3 last:border-0">
            <Skeleton width="100%" height={10} />
          </div>
        ))}
      </div>
    );
  }
  if (!steps.length) return <p className="border border-rule bg-surface px-4 py-3 text-13 text-ink-2">This run has no recorded steps.</p>;
  const deltas = stepDeltas(steps);

  return (
    <div className="overflow-x-auto border border-rule bg-surface">
      <table className="w-full min-w-[640px] table-fixed text-12">
        <caption className="sr-only">Steps in this run, in order</caption>
        <thead className="border-b border-rule text-left text-ink-2">
          <tr>
            <th scope="col" className="w-10 px-3 py-2 font-medium">#</th>
            <th scope="col" className="w-40 px-3 py-2 font-medium">Node</th>
            <th scope="col" className="w-40 px-3 py-2 font-medium">Kind</th>
            <th scope="col" className="px-3 py-2 font-medium">Name</th>
            <th scope="col" className="w-20 px-3 py-2 text-right font-medium">Since prev</th>
            <th scope="col" className="w-20 px-3 py-2 text-right font-medium">Context</th>
            <th scope="col" className="w-16 px-3 py-2 font-medium"><span className="sr-only">Payload</span></th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const d = deltas.get(s.seq) ?? null;
            const expanded = open.has(s.seq);
            const tokens = contextTokens(s);
            return (
              <StepRows key={s.seq} expanded={expanded} payload={s.payload}>
                <td className="tabular px-3 py-1.5 font-mono text-ink-2">{String(s.seq).padStart(2, '0')}</td>
                <td className="truncate px-3 py-1.5 font-mono" title={s.node}>{s.node}</td>
                <td className="truncate px-3 py-1.5" title={s.kind}>{statusLabel(s.kind)}</td>
                <td className="truncate px-3 py-1.5 font-mono" title={stepName(s)}>{stepName(s)}</td>
                <td className="tabular px-3 py-1.5 text-right font-mono text-ink-2">{d === null ? '-' : formatDuration(d)}</td>
                <td className="tabular px-3 py-1.5 text-right font-mono text-ink-2">{tokens === null ? '-' : tokens.toLocaleString('en-IN')}</td>
                <td className="px-3 py-1.5">
                  <button
                    type="button"
                    className="link text-12"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} payload for step ${s.seq}`}
                    onClick={() => toggle(s.seq)}
                  >
                    {expanded ? 'Hide' : 'JSON'}
                  </button>
                </td>
              </StepRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StepRows({ children, expanded, payload }: { children: React.ReactNode; expanded: boolean; payload: Record<string, unknown> }) {
  return (
    <>
      <tr className="border-b border-rule last:border-0">{children}</tr>
      {expanded ? (
        <tr className="border-b border-rule bg-surface-sunk">
          <td colSpan={7} className="px-3 py-2">
            <pre className="max-h-72 overflow-auto font-mono text-11 leading-4 break-words whitespace-pre-wrap text-ink">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
