import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CONTEXT_BUDGET, formatMoney, type AgentName, type AgentRunItem, type AgentStepItem, type CaseDetail, type Finding, type GroundingViolation } from '@payops/shared';
import { formatDateTime, formatDecisionAnswer, statusLabel } from '../../lib/format';
import { can } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { EvidenceRef, evidenceAnchor } from '../../ui/EvidenceRef';
import { Section } from '../../ui/Section';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { cx } from '../../ui/cx';
import { activeRun, useRuns, useRunSteps, useStartRun } from './api';

export function Investigation({ c }: { c: CaseDetail }) {
  const runs = useRuns(c.id);
  const start = useStartRun(c.id);
  const user = useUser();
  const [selected, setSelected] = useState<string>();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const run = runs.data?.items.find((r) => r.id === selected) ?? runs.data?.items[0];
  const steps = useRunSteps(run);
  const busy = runs.data?.items.some((r) => activeRun(r.status) || r.status === 'AWAITING_APPROVAL');
  const allowed = can(user?.role, 'resolve') && c.resolutionView.canPropose && !busy;
  const citation = (id: string) => run?.evidence.some((e) => e.id === id)
    ? <EvidenceRef runId={run.id} id={id} onHighlight={setHighlighted} /> : <span className="font-mono text-12">[{id}]</span>;
  const narrative = (text: string) => text.split(/(\[ev_\d+(?:, ev_\d+)*\])/g).map((part, i) => (
    <Fragment key={i}>{/^\[ev_/.test(part) ? part.slice(1, -1).split(', ').map((id) => <Fragment key={id}>{citation(id)}{' '}</Fragment>) : part}</Fragment>
  ));

  return (
    <section className="mt-6 border border-rule bg-surface" aria-label="Case investigation">
      <header className="flex min-h-12 flex-wrap items-center gap-3 border-b border-rule px-4 py-2">
        {runs.isPending ? <Skeleton width={200} /> : run ? <>
          <span className="font-mono text-12 break-all">{run.id} · attempt {run.attempt}</span>
          <Tag tone={run.status === 'RESOLVED' ? 'ok' : run.status === 'FAILED' ? 'bad' : 'neutral'}>{run.status}</Tag>
          {run.path ? <Tag>{run.path}</Tag> : null}
          <span className="font-mono text-12 text-ink-2">{run.budget.toolCalls} tools · {run.budget.llmCalls} LLM calls · {run.budget.jevCalls} Jev calls · {run.budget.tokensIn + run.budget.tokensOut} tokens</span>
        </> : <span className="text-13 text-ink-2">No investigation started</span>}
        <div className="ml-auto flex items-center gap-3">
          {(runs.data?.items.length ?? 0) > 1 ? <Select label="Investigation run" allLabel="Latest run" value={selected} onChange={setSelected} width={200}
            options={runs.data!.items.map((r) => ({ value: r.id, label: `${formatDateTime(r.createdAt)} · ${r.status}` }))} /> : null}
          {allowed ? <Button variant="primary" disabled={start.isPending || runs.isPending || runs.isError} onClick={() => start.mutate(undefined, { onSuccess: ({ runId }) => setSelected(runId) })}>
            {start.isPending ? 'Starting investigation…' : 'Start investigation'}
          </Button> : null}
        </div>
      </header>
      {start.isError ? <ErrorState title="Could not start investigation." error={start.error} onRetry={() => start.mutate()} /> : null}
      {runs.isError ? <ErrorState title="Could not load investigations." error={runs.error} onRetry={() => void runs.refetch()} /> : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,4fr)]">
          <Section title="Investigation" titleId="investigation-title">
            <p className="sr-only" role="status">{run ? `Investigation ${statusLabel(run.status)}. ${steps.data?.items.length ?? 0} steps recorded.` : 'No investigation started.'}</p>
            {runs.isPending || (run && steps.isPending) ? <InvestigationSkeleton /> : steps.isError ? <ErrorState title="Could not load steps." error={steps.error} onRetry={() => void steps.refetch()} /> : run ? <Trace steps={steps.data?.items ?? []} run={run} /> : <EmptyState message="Start an investigation to collect evidence and propose a resolution." />}
          </Section>
          <Section title="Findings & resolution" titleId="findings-title" className="border-t border-rule xl:border-t-0 xl:border-l" bodyClassName="space-y-4 p-4 text-13">
            {runs.isPending ? <InvestigationSkeleton /> : !run?.diagnosis ? <p className="text-ink-2">{run ? 'Collecting evidence. Findings appear when the investigation completes.' : 'No findings yet.'}</p> : <>
              <div><h3 className="mb-1 font-semibold">Root cause</h3><p>{narrative(run.diagnosis.narrative)}</p></div>
              {run.findings.map((finding) => <FindingLine key={finding.id} finding={finding} violation={run.grounding?.violations.find((v) => v.findingId === finding.id) ?? null} citation={citation} />)}
              {run.proposal ? <div className="space-y-2 border-t border-rule pt-3">
                <h3 className="font-semibold">Proposed resolution</h3>
                <ol className="list-decimal space-y-2 pl-5">{run.proposal.actions.map((action, i) => <li key={i} className="font-mono text-12 break-words">{action.type}{'amountMinor' in action.params ? ` · ${formatMoney(action.params.amountMinor)}` : ''}</li>)}</ol>
                {run.proposal.expectedPostconditions.map((text, i) => <p className="text-ink-2" key={i}>{text}</p>)}
              </div> : null}
              {run.policy ? <p>Policy: <Tag>{run.policy.tier}</Tag></p> : null}
              {run.status === 'AWAITING_APPROVAL' && run.approvalId ? <Link className="link" to={`/approvals?approval=${encodeURIComponent(run.approvalId)}`}>Review approval</Link> : null}
              {run.validation ? <p>Verification: <Tag tone={run.validation.verdict === 'PASS' ? 'ok' : 'bad'}>{run.validation.verdict}</Tag><span className="ml-2 text-ink-2">Check results are listed in Resolution below.</span></p> : null}
            </>}
            {run?.status === 'FAILED' ? <p role="alert" className="text-bad">Investigation failed. Review the trace or resolve this case manually.</p> : null}
          </Section>
          <Section title="Evidence" titleId="evidence-title" aside={run ? `${run.evidence.length} items` : undefined} className="border-t border-rule xl:border-t-0 xl:border-l">
            {runs.isPending ? <InvestigationSkeleton /> : !run?.evidence.length ? <EmptyState message="No evidence collected yet." /> : <ol className="max-h-[640px] overflow-y-auto">
              {run.evidence.map((item) => <li key={item.id} id={evidenceAnchor(run.id, item.id)} tabIndex={-1}
                className={cx('scroll-m-2 border-b border-rule p-3 text-12 last:border-0', highlighted === item.id && 'bg-accent-weak')}>
                <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-medium">{item.id}</span><Tag>{item.system}</Tag></div>
                <p className="mt-1 font-mono break-all text-ink-2">{item.source} · {item.entityRef}</p>
                <dl className="mt-2 space-y-1">{Object.entries(item.facts).map(([key, value]) => <div key={key} className="flex flex-wrap justify-between gap-x-3">
                  <dt className="text-ink-2">{key}</dt><dd className="font-mono break-all">{key.endsWith('Minor') && typeof value === 'number' ? formatMoney(value) : String(value)}</dd>
                </div>)}</dl>
                <time dateTime={item.observedAt} className="mt-2 block font-mono text-ink-2">{formatDateTime(item.observedAt)}</time>
              </li>)}
            </ol>}
          </Section>
        </div>
      )}
    </section>
  );
}

export function Trace({ steps, run }: { steps: AgentStepItem[]; run: AgentRunItem }) {
  if (!steps.length) return <EmptyState message="Investigation queued. Waiting for the first step." />;
  return <ol className="max-h-[640px] overflow-y-auto">{steps.map((step) => {
    const finished = steps.some((s) => s.seq > step.seq && s.node === step.node && s.kind === 'NODE_COMPLETED');
    const status = step.kind === 'RUN_FAILED' ? 'FAILED' : step.kind === 'NODE_STARTED' && !finished
      ? run.status === 'AWAITING_APPROVAL' && step.node === 'awaitApproval' ? 'WAITING' : activeRun(run.status) ? 'RUNNING' : 'STOPPED' : 'DONE';
    return <li key={step.seq} className="border-b border-rule px-3 py-2 text-12 last:border-0">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-ink-2">{String(step.seq).padStart(2, '0')}</span><span className="font-mono">{step.node}</span><Tag tone={status === 'FAILED' ? 'bad' : 'neutral'}>{status}</Tag></div>
      <p className="mt-1 text-ink-2">{statusLabel(step.kind)} · <time dateTime={step.at} className="font-mono">{formatDateTime(step.at)}</time></p>
      {Array.isArray(step.payload.tools) ? <p className="mt-1 font-mono break-words">{step.payload.tools.join(', ')}</p> : null}
      {step.kind === 'DECISION_MADE' ? <DecisionSummary payload={step.payload} /> : null}
      {step.kind === 'LLM_CALLED' ? <LlmCallSummary node={step.node} payload={step.payload} /> : null}
      {typeof step.payload.error === 'string' ? <p className="mt-1 break-words text-bad">{step.payload.error}</p> : null}
    </li>;
  })}</ol>;
}

/**
 * A Jev decision point in the trace (docs/03 §4 J1-J6, docs/05 §11 case screen mockup:
 * "plan · primary: webhook_or_state_sync · conf 0.82"). One line per answer, dense and mono --
 * this is the "AI decision" surface the doc's §9 tells warn against dressing up with badges or
 * a wall of JSON, so it stays plain text like every other status line in the trace.
 */
function DecisionSummary({ payload }: { payload: Record<string, unknown> }) {
  const tag = typeof payload.tag === 'string' ? payload.tag : null;
  const answers = payload.answers && typeof payload.answers === 'object' ? payload.answers as Record<string, unknown> : {};
  const lines = Object.entries(answers).map(([key, answer]) => formatDecisionAnswer(key, answer)).filter((line): line is string => line !== null);
  if (!tag && lines.length === 0) return null;
  return <div className="mt-1">
    {tag ? <p className="font-mono text-11 text-ink-2">{tag}</p> : null}
    {lines.length ? <ul className="mt-0.5 space-y-0.5">{lines.map((line, i) => <li key={i} className="font-mono text-12 break-words">{line}</li>)}</ul> : null}
  </div>;
}

const NODE_AGENT: Partial<Record<string, AgentName | 'resolve'>> = {
  paymentAgent: 'payment',
  reconciliationAgent: 'reconciliation',
  riskAgent: 'risk',
  resolve: 'resolve',
};

/**
 * A model call's context size against its per-agent budget (docs/03 §8: "every built context is
 * hashed and its token estimate stored on the agentStep. The Agent Runs screen shows context
 * size per call" -- this is that screen, Phase 4's own "context sizes per call are visible and
 * within budget" done-when check). Plain mono text, same density as DecisionSummary.
 */
function LlmCallSummary({ node, payload }: { node: string; payload: Record<string, unknown> }) {
  const tokens = typeof payload.contextTokenEstimate === 'number' ? payload.contextTokenEstimate : null;
  if (tokens === null) return null;
  const agent = NODE_AGENT[node];
  const budget = agent ? CONTEXT_BUDGET[agent] : undefined;
  const over = budget !== undefined && tokens > budget;
  const call = typeof payload.call === 'string' ? payload.call : 'call';
  return <p className={cx('mt-1 font-mono text-11', over ? 'text-bad' : 'text-ink-2')}>
    {call} context: {tokens.toLocaleString('en-IN')}{budget !== undefined ? ` / ${budget.toLocaleString('en-IN')} tok budget` : ' tok'}{over ? ' (over budget, sections dropped)' : ''}
  </p>;
}

/**
 * One finding's statement plus its evidence citations (docs/05 §11). A finding named by a J4
 * `GroundingViolation` (Phase 4 task 8) is shown struck through in the muted secondary text
 * color, never `--bad` -- the doc's status colors are reserved for a live PASS/FAIL/MISMATCH
 * meaning, not for "this claim was dropped", which is a calmer, already-resolved state (see
 * docs/DECISIONS.md D044). Its citations are plain mono text, not links: a dropped claim isn't
 * something the reader should be invited to click through to evidence as if it were live.
 */
export function FindingLine({ finding, violation, citation }: {
  finding: Finding;
  violation: GroundingViolation | null;
  citation: (id: string) => ReactNode;
}) {
  return <div>
    <p className={violation ? 'text-ink-2 line-through' : undefined}>
      {finding.statement}{' '}
      {finding.evidenceIds.map((id) => violation
        ? <span key={id} className="mr-1 font-mono text-12 text-ink-3">[{id}]</span>
        : <Fragment key={id}>{citation(id)}{' '}</Fragment>)}
    </p>
    {violation ? <p className="text-12 text-ink-2">Dropped: {violation.reason}</p> : null}
  </div>;
}

export function InvestigationSkeleton() {
  return <div aria-hidden="true" className="space-y-4 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={24} />)}</div>;
}
