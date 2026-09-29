import { useState } from 'react';
import { Link } from 'react-router';
import { CASE_TYPE_LABEL, dueLabel, renderHandoffText, type HandoffSummary } from '@payops/shared';
import { ageLabel, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/use-document-title';
import { pickEnum, useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Money } from '../../ui/Money';
import { PageHeader } from '../../ui/PageHeader';
import { Section } from '../../ui/Section';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { useHandoff } from '../workflow/api';

const WINDOWS = ['4', '8', '12', '24'] as const;
const windowOptions = WINDOWS.map((h) => ({ value: h, label: `${h} hours` }));

function Count({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="px-5 py-4">
      <dt className="text-13 text-ink-2">{label}</dt>
      <dd className={`tabular mt-1 font-mono text-24 font-semibold ${bad && value > 0 ? 'text-bad' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

/** Pure view of a summary: no queries, so it renders and tests without network hooks. */
export function HandoffView({ h, now }: { h: HandoffSummary; now: Date }) {
  const s = h.open.bySeverity;
  return (
    <>
      <dl className="grid grid-cols-2 divide-x divide-y divide-rule rounded-lg border border-rule bg-surface sm:grid-cols-4 sm:divide-y-0">
        <Count label="Open" value={h.open.total} />
        <Count label="Overdue" value={h.open.overdue} bad />
        <Count label="Waiting for approval" value={h.open.awaitingApproval} />
        <Count label="Unassigned" value={h.open.unassigned} />
      </dl>
      <p className="mt-3 text-13 text-ink-2">
        Open by severity: critical <span className="tabular font-mono">{s.CRITICAL}</span>, high <span className="tabular font-mono">{s.HIGH}</span>, medium{' '}
        <span className="tabular font-mono">{s.MEDIUM}</span>, low <span className="tabular font-mono">{s.LOW}</span>. Resolved in the last {plural(h.sinceHours, 'hour')}:{' '}
        <span className="tabular font-mono">{h.resolved.total}</span> (agent {h.resolved.by.AGENT}, people {h.resolved.by.USER}, system {h.resolved.by.SYSTEM}).
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-rule">
        <Section title="Needs attention" titleId="attention-title" aside={<span className="tabular font-mono">{h.needsAttention.length}</span>}>
          {h.needsAttention.length === 0 ? (
            <p className="px-5 py-4 text-14 text-ink-2">Nothing is overdue, critical or waiting for approval.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {h.needsAttention.map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-14">
                    <Link to={`/cases/${c.id}`} className="link tabular font-mono">
                      {c.displayId}
                    </Link>
                    <span>{CASE_TYPE_LABEL[c.type]}</span>
                    <Money minor={c.amountMinor} />
                    {c.reasons.map((r) => (
                      <Tag key={r} tone={r === 'Overdue' || r === 'Critical' ? 'bad' : 'warn'}>
                        {r}
                      </Tag>
                    ))}
                    <span className="text-ink-2">{c.dueAt ? dueLabel(c.dueAt, now) : 'no due time'}</span>
                    <span className="text-ink-2">{c.assigneeName ?? 'Unassigned'}</span>
                  </div>
                  {c.lastNote ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-13 text-ink-2">
                      {c.lastNote.authorName}: {c.lastNote.text}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-rule">
        <Section title="Notes this shift" titleId="recent-notes-title" aside={<span className="tabular font-mono">{h.recentNotes.length}</span>}>
          {h.recentNotes.length === 0 ? (
            <p className="px-5 py-4 text-14 text-ink-2">No one wrote a note in this window.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {h.recentNotes.map((n, i) => (
                <li key={`${n.caseId}-${n.at}-${i}`} className="px-5 py-3 text-14">
                  <p className="whitespace-pre-wrap break-words">{n.text}</p>
                  <p className="mt-1 text-12 text-ink-2">
                    <Link to={`/cases/${n.caseId}`} className="link tabular font-mono">
                      {n.displayId}
                    </Link>
                    , {n.authorName}, {ageLabel(n.at, now) === 'now' ? 'just now' : `${ageLabel(n.at, now)} ago`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

/** Copy button that says what happened, and never throws when the clipboard is blocked. */
export function CopyText({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => setState('copied'),
            () => setState('failed'),
          );
        }}
      >
        Copy as text
      </Button>
      <span role="status" className="text-13 text-ink-2">
        {state === 'copied' ? 'Copied.' : state === 'failed' ? 'Could not copy. Select the text below instead.' : ''}
      </span>
    </span>
  );
}

export function HandoffPage() {
  useDocumentTitle('Shift handoff');
  const [url, setUrl] = useUrlState(['hours'] as const);
  const hours = pickEnum(url.hours, WINDOWS) ?? '8';
  const q = useHandoff(Number(hours));
  const h = q.data;

  return (
    <>
      <PageHeader
        title="Shift handoff"
        meta="What the next operator needs to know. Counted from live data; nothing here is written by a model."
        actions={h ? <CopyText text={renderHandoffText(h)} /> : null}
      />
      <div className="mb-4">
        <Segmented label="Time window" value={hours} options={windowOptions} onChange={(v) => setUrl({ hours: v === '8' ? undefined : v })} />
      </div>
      {q.isError && !h ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load the handoff." error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : h ? (
        <>
          <HandoffView h={h} now={new Date(h.generatedAt)} />
          <details className="mt-6 rounded-lg border border-rule bg-surface">
            <summary className="cursor-pointer px-5 py-3 text-14 font-medium hover:bg-surface-sunk">Text version</summary>
            <pre className="overflow-x-auto border-t border-rule px-5 py-4 font-mono text-12 whitespace-pre-wrap">{renderHandoffText(h)}</pre>
          </details>
        </>
      ) : (
        <div aria-busy="true" aria-label="Loading handoff" className="space-y-4">
          <Skeleton height={84} width="100%" />
          <Skeleton height={16} width="70%" />
          <Skeleton height={160} width="100%" />
        </div>
      )}
    </>
  );
}
