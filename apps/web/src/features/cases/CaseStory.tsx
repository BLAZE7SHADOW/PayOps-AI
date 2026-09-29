import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CaseDetail } from '@payops/shared';
import { formatDateTime } from '../../lib/format';
import { ErrorState } from '../../ui/ErrorState';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import type { Tone } from '../../lib/status';
import { activeRun, useRuns, useRunSteps } from '../investigation/api';
import { buildCaseStory, type ApprovalState, type StoryActor, type StoryEntry, type StoryState } from './case-story';
import { useCaseSourceRecords } from './api';
import { RecordDrawer } from './RecordDrawer';

const ACTOR_TITLE: Record<StoryActor, string> = {
  PERSON: 'A person decided this',
  JEV: 'Jev, a typed decision service, decided this',
  GEMINI: 'Gemini, a language model, wrote this',
  CODE: 'Fixed code produced this, no model involved',
};

const STATE_TAG: Partial<Record<StoryState, { tone: Tone; label: string }>> = {
  WAITING: { tone: 'warn', label: 'Waiting' },
  RUNNING: { tone: 'accent', label: 'Running' },
  FAILED: { tone: 'bad', label: 'Failed' },
  STOPPED: { tone: 'neutral', label: 'Stopped' },
};

/**
 * The one place to read a case from start to finish (D060): what the systems said, what the
 * investigation checked, what it concluded, the record behind each claim, and what changed.
 * Every claim opens its record in a drawer; the run view and audit log remain for deep inspection.
 */
export function CaseStory({ c }: { c: CaseDetail }) {
  const runs = useRuns(c.id);
  const run = runs.data?.items[0];
  const steps = useRunSteps(run);
  const live = Boolean(run && activeRun(run.status));
  const records = useCaseSourceRecords(c.id, live);
  const [params, setParams] = useSearchParams();
  const refId = params.get('ref');
  const setRef = (value: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set('ref', value); else next.delete('ref');
    return next;
  }, { replace: true });

  const story = useMemo(
    () => buildCaseStory({ c, run, steps: steps.data?.items ?? [], records: records.data }),
    [c, run, steps.data, records.data],
  );
  const latestResolution = c.resolutionView?.resolutions
    .slice().sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt))
    .find((r) => (run?.resolutionId ? r.id === run.resolutionId : true));
  const pending = runs.isPending || (Boolean(run) && steps.isPending);

  return (
    <section aria-labelledby="story-title" className="min-w-0 overflow-hidden rounded-lg border border-rule bg-surface">
      <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-5 py-3">
        <h2 id="story-title" className="text-18 font-semibold">What happened, step by step</h2>
        <p className="text-13 text-ink-2">{run ? `Latest investigation, attempt ${run.attempt}` : 'No investigation has run'}</p>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-13">
          {run ? <Link className="link" to={`/runs/${run.id}`}>Open run details</Link> : null}
          <Link className="link" to={`/audit?caseId=${encodeURIComponent(c.id)}`}>Open audit trail</Link>
          {c.entityRefs.paymentId ? <Link className="link" to={`/payments?payment=${encodeURIComponent(c.entityRefs.paymentId)}`}>Open payment details</Link> : null}
          <button type="button" className="link disabled:opacity-50" disabled={records.isFetching} onClick={() => void records.refetch()}>
            {records.isFetching && records.data ? 'Refreshing records…' : 'Refresh source records'}
          </button>
        </div>
      </header>
      <p className="border-b border-rule px-5 py-2 text-12 text-ink-2">
        {records.data ? <>Values marked “now” were read from the source records at <time dateTime={records.data.readAt}>{formatDateTime(records.data.readAt)}</time>.</> : 'Reading the source records.'}
        {' '}Each label shows who produced the step: fixed code, Jev, Gemini, or a person.
      </p>

      {runs.isError ? <ErrorState title="Could not load the investigation." error={runs.error} onRetry={() => void runs.refetch()} /> : pending ? <StorySkeleton /> : (
        <>
          <p className="sr-only" role="status">{story.length} steps recorded.</p>
          <StoryList story={story} onOpen={setRef} pendingApprovalId={c.resolutionView?.pendingApprovalId ?? null} />
        </>
      )}
      <RecordDrawer refId={refId} onClose={() => setRef(null)} onOpen={setRef} caseId={c.id} run={run} records={records.data} resolution={latestResolution} />
    </section>
  );
}

export function StoryList({ story, onOpen, pendingApprovalId }: { story: StoryEntry[]; onOpen: (ref: string) => void; pendingApprovalId: string | null }) {
  return <ol>{story.map((entry) => <Entry key={entry.key} entry={entry} onOpen={onOpen} pendingApprovalId={pendingApprovalId} />)}</ol>;
}

export function StorySkeleton() {
  return (
    <div className="space-y-6 p-5" aria-hidden="true">
      {[0, 1, 2].map((i) => <div key={i}><Skeleton width={220} height={18} /><Skeleton width="80%" className="mt-3" /><Skeleton width="55%" className="mt-2" /></div>)}
    </div>
  );
}

function ActorTags({ entry }: { entry: StoryEntry }) {
  return (
    <>
      {entry.actors.map((actor) => (
        <Tag key={actor} title={ACTOR_TITLE[actor]}>{actor === 'JEV' && entry.jev.length ? `Jev · ${entry.jev.join(', ')}` : actor}</Tag>
      ))}
    </>
  );
}

function Chip({ id, onOpen, children }: { id: string; onOpen: (id: string) => void; children?: ReactNode }) {
  return <button type="button" className="link font-mono text-12" onClick={() => onOpen(id)}>{children ?? `[${id}]`}</button>;
}

function Entry({ entry, onOpen, pendingApprovalId }: { entry: StoryEntry; onOpen: (ref: string) => void; pendingApprovalId: string | null }) {
  const stateTag = STATE_TAG[entry.state];
  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 border-b border-rule px-5 py-4 last:border-b-0">
      <span className="pt-0.5 font-mono text-13 text-ink-2">{entry.number}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ActorTags entry={entry} />
          <h3 className="text-15 font-semibold">{entry.title}</h3>
          {stateTag ? <Tag tone={stateTag.tone}>{stateTag.label}</Tag> : null}
          {entry.at ? <time dateTime={entry.at} className="tabular font-mono text-12 text-ink-2">{formatDateTime(entry.at)}</time> : null}
        </div>
        <p className="mt-1 max-w-[80ch] text-15 leading-relaxed">{entry.summary}</p>
        {entry.details.length ? <ul className="mt-1 space-y-0.5 text-13 text-ink-2">{entry.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        <Body entry={entry} onOpen={onOpen} pendingApprovalId={pendingApprovalId} />
      </div>
    </li>
  );
}

function Body({ entry, onOpen, pendingApprovalId }: { entry: StoryEntry; onOpen: (ref: string) => void; pendingApprovalId: string | null }) {
  switch (entry.kind) {
    case 'step':
      return (
        <>
          {entry.facts.length ? (
            <div className="mt-3">
              <p className="flex items-center gap-2 text-12 font-medium text-ink-2"><Tag tone="ok">Confirmed by data</Tag> Records read</p>
              <ul className="mt-1 divide-y divide-rule border border-rule">
                {entry.facts.map((f) => (
                  <li key={f.evidenceId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-13">
                    <Chip id={f.evidenceId} onOpen={onOpen} />
                    <span className="font-medium">{f.label}</span>
                    <span className="min-w-0 font-mono text-12 text-ink-2">{f.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {entry.findings.length ? (
            <div className="mt-3 space-y-2">
              {entry.findings.map((f) => (
                <div key={f.id} className="border border-rule bg-paper p-3">
                  <p className="text-14">{f.statement}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-12">
                    <Tag tone="warn">Agent finding</Tag>
                    <Tag tone={f.grounding === 'SUPPORTED' ? 'ok' : f.grounding === 'UNSUPPORTED' ? 'bad' : 'neutral'}>
                      {f.grounding === 'SUPPORTED' ? 'Evidence check passed' : f.grounding === 'UNSUPPORTED' ? 'Not supported by its evidence' : 'Evidence not checked'}
                    </Tag>
                    <span className="text-ink-2">Relies on</span>
                    {f.evidenceIds.map((id) => <Chip key={id} id={id} onOpen={onOpen} />)}
                    <span className="font-mono text-ink-2">{f.id} · confidence {Math.round(f.confidence * 100)}%</span>
                  </div>
                  {f.reason ? <p className="mt-1 text-12 text-bad">{f.reason}</p> : null}
                </div>
              ))}
              <p className="text-12 text-ink-2">A finding is the agent’s reading of the records. Open its evidence to check it yourself.</p>
            </div>
          ) : null}
          {entry.retries.length ? <div className="mt-3 border border-dashed border-rule-strong p-2 text-13"><Tag tone="warn">Retry</Tag> {entry.retries.join(' ')}</div> : null}
        </>
      );
    case 'decision':
      return (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1 text-14">
            <dt className="text-ink-2">Why</dt><dd>{entry.rationale}</dd>
            {entry.expected.length ? <><dt className="text-ink-2">Expected result</dt><dd>{entry.expected.join(' ')}</dd></> : null}
            <dt className="text-ink-2">Policy tier</dt>
            <dd><span className="font-mono">{entry.tier}</span>{entry.tierReasons.length ? <span className="text-ink-2">. {entry.tierReasons.join(' ')}</span> : null}</dd>
          </dl>
          <ApprovalBlock approval={entry.approval} pendingApprovalId={pendingApprovalId} />
          {entry.earlierAttempts > 0 ? <p className="text-12 text-ink-2">{entry.earlierAttempts} earlier attempt{entry.earlierAttempts === 1 ? '' : 's'} did not pass. They are listed under Technical detail below.</p> : null}
        </div>
      );
    case 'execution':
      return (
        <div className="mt-3 space-y-3">
          {entry.steps.map((s) => (
            <div key={s.index} className="border border-rule">
              <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface-sunk px-3 py-2 text-13">
                <span className="font-mono text-ink-2">Step {s.index + 1}</span><span className="font-medium">{s.label}</span>
                <Tag tone={s.status === 'SUCCEEDED' ? 'ok' : s.status === 'FAILED' ? 'bad' : 'neutral'}>{s.status}</Tag>
              </div>
              <p className="px-3 py-2 text-13">{s.summary}</p>
              {s.error ? <p className="px-3 pb-2 text-13 text-bad">{s.error}</p> : null}
              {s.status === 'SUCCEEDED' && !s.hasBefore ? <p className="px-3 pb-2 text-12 text-ink-2">The before-state was not recorded for this step, so no comparison is shown.</p> : null}
              {s.changes.length ? (
                <table className="w-full text-left text-13">
                  <thead className="bg-surface-sunk text-11 font-medium uppercase tracking-wide text-ink-2"><tr><th scope="col" className="px-3 py-1.5">Record</th><th scope="col" className="px-3 py-1.5">Before</th><th scope="col" className="px-3 py-1.5">Now</th></tr></thead>
                  <tbody>{s.changes.map((ch) => (
                    <tr key={ch.recordId} className="border-t border-rule">
                      <td className="px-3 py-2"><Chip id={`rec:${ch.recordId}`} onOpen={onOpen}>{ch.label}</Chip>{ch.isNew ? <span className="ml-2 text-12 text-ink-2">new record</span> : null}</td>
                      <td className="px-3 py-2 font-mono text-12">{ch.before}</td>
                      <td className="bg-ok-weak px-3 py-2 font-mono text-12">{ch.after}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : s.hasBefore && s.status === 'SUCCEEDED' ? <p className="px-3 pb-2 text-12 text-ink-2">No source record changed compared with the recorded before-state.</p> : null}
            </div>
          ))}
        </div>
      );
    case 'verification':
      return (
        <div className="mt-3 overflow-x-auto border border-rule" role="region" aria-label="Verification checks" tabIndex={0}>
          <table className="w-full min-w-[520px] text-left text-13">
            <thead className="bg-surface-sunk text-11 font-medium uppercase tracking-wide text-ink-2"><tr><th scope="col" className="px-3 py-1.5">Check</th><th scope="col" className="px-3 py-1.5">Expected</th><th scope="col" className="px-3 py-1.5">Actual</th><th scope="col" className="px-3 py-1.5">Result</th></tr></thead>
            <tbody>{entry.checks.map((k) => (
              <tr key={k.id} className="border-t border-rule">
                <td className="px-3 py-2">{k.description}</td>
                <td className="px-3 py-2 font-mono text-12">{k.expected}</td>
                <td className={`px-3 py-2 font-mono text-12 ${k.pass ? 'bg-ok-weak' : 'bg-bad-weak'}`}>{k.actual}</td>
                <td className="px-3 py-2"><Tag tone={k.pass ? 'ok' : 'bad'}>{k.pass ? 'Pass' : 'Fail'}</Tag></td>
              </tr>
            ))}</tbody>
          </table>
          <p className="border-t border-rule px-3 py-2 text-12 text-ink-2">Overall result: <Tag tone={entry.verdict === 'PASS' ? 'ok' : entry.verdict === 'FAIL' ? 'bad' : 'warn'}>{entry.verdict}</Tag></p>
        </div>
      );
    case 'running':
      return <div className="mt-3" aria-hidden="true"><Skeleton width="70%" /><Skeleton width="45%" className="mt-2" /></div>;
    default:
      return null;
  }
}

function ApprovalBlock({ approval, pendingApprovalId }: { approval: ApprovalState; pendingApprovalId: string | null }) {
  const at = (iso: string) => (iso ? ` at ${formatDateTime(iso)}` : '');
  const shell = 'flex flex-wrap items-center gap-x-3 gap-y-1 border border-rule-strong bg-surface px-3 py-2 text-14';
  switch (approval.status) {
    case 'AUTOMATIC':
      return <p className={shell}><Tag tone="ok">Automatic</Tag> No approval was needed. Policy allowed the executor to run this action directly.</p>;
    case 'WAITING':
      return (
        <p className={shell}><Tag tone="warn">Waiting for {approval.role}</Tag> A {approval.role} approval is required before anything changes. Nothing has been changed yet.
          {pendingApprovalId ? <Link className="link" to={`/approvals?approval=${encodeURIComponent(pendingApprovalId)}`}>Review the approval request</Link> : null}
        </p>
      );
    case 'APPROVED':
      return <p className={shell}><Tag tone="ok">Approved</Tag> Approved by {approval.by}{at(approval.at)}.</p>;
    case 'REJECTED':
      return <p className={shell}><Tag tone="bad">Rejected</Tag> Rejected by {approval.by}{at(approval.at)}.{approval.comment ? ` Reason: ${approval.comment}` : ''}</p>;
    case 'ESCALATED':
      return <p className={shell}><Tag tone="warn">Escalated</Tag> Escalated by {approval.by}{at(approval.at)}.</p>;
    case 'BLOCKED':
      return <p className={shell}><Tag tone="bad">Blocked</Tag> Policy blocked this action, so it cannot be approved or run.</p>;
  }
}
