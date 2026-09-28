import { ACTION_META, type ExecutionStep, type ResolutionItem } from '@payops/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatDateTime, formatFullDateTime, statusLabel } from '../../lib/format';
import { formatDuration, resolutionTone } from '../../lib/resolution';
import { MonoIds } from '../../ui/MonoIds';
import { Tag } from '../../ui/Tag';
import { ActionList, Actor, PolicySummary, Quote } from './parts';
import { VerificationTable } from './VerificationTable';

const When = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={formatFullDateTime(iso)} className="tabular font-mono text-12 text-ink-2">
    {formatDateTime(iso)}
  </time>
);

function Sub({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-4">
      <div className="flex items-baseline justify-between gap-3 pb-1.5">
        <h4 className="text-12 font-medium text-ink-2">{title}</h4>
        {aside ? <span className="text-12 text-ink-2">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One resolution attempt: who proposed what, under which policy, who approved, what ran, what was verified. */
export function AttemptBlock({ r }: { r: ResolutionItem }) {
  return (
    <div className="px-4 pt-3 pb-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-13">
        <span className="font-medium text-ink">Attempt {r.attempt}</span>
        <Tag tone={resolutionTone.status(r.status)}>{statusLabel(r.status)}</Tag>
        {r.validation ? <Tag tone={resolutionTone.verdict(r.validation.verdict)}>{r.validation.verdict}</Tag> : null}
        <span aria-hidden="true" className="text-ink-3">·</span>
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          Proposed by <Actor actor={r.proposedBy} />
        </span>
        <When iso={r.createdAt} />
        <PolicySummary policy={r.policy} className="ml-auto" />
      </header>

      <div className="grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-x-6">
        <Sub title="Actions">
          <div className="border border-rule px-3">
            <ActionList actions={r.actions} />
          </div>
        </Sub>
        <div>
          <Sub title="Rationale">
            <Quote>{r.rationale}</Quote>
          </Sub>
          <Sub title="Approval">
            <ApprovalLine r={r} />
          </Sub>
        </div>
      </div>

      <Sub title="Execution" aside={r.executions.length ? `${r.executions.length} ${r.executions.length === 1 ? 'step' : 'steps'}` : undefined}>
        {r.executions.length ? (
          <ExecutionTable steps={r.executions} />
        ) : (
          <p className="border border-rule bg-surface px-3 py-2 text-13 text-ink-2">{notExecutedReason(r)}</p>
        )}
      </Sub>

      <Sub title="Verification">
        {r.validation ? (
          <VerificationTable validation={r.validation} actions={r.actions} />
        ) : (
          <p className="border border-rule bg-surface px-3 py-2 text-13 text-ink-2">
            {r.status === 'EXECUTING'
              ? 'Verification runs after the last step finishes.'
              : r.status === 'AWAITING_APPROVAL'
                ? 'The validator runs after approval and execution.'
                : 'Not verified. Nothing was executed.'}
          </p>
        )}
      </Sub>
    </div>
  );
}

function notExecutedReason(r: ResolutionItem): string {
  switch (r.status) {
    case 'AWAITING_APPROVAL':
      return 'Runs after approval.';
    case 'BLOCKED':
      return 'Blocked by policy. Nothing ran.';
    case 'REJECTED':
      return 'Rejected. Nothing ran.';
    case 'ESCALATED':
      return 'Escalated. Nothing ran.';
    default:
      return 'No steps recorded yet.';
  }
}

function ApprovalLine({ r }: { r: ResolutionItem }) {
  const a = r.approval;
  if (!a) {
    return <p className="text-13 text-ink-2">{r.policy.tier === 'AUTO' ? 'Not needed. Policy tier AUTO.' : 'No approval recorded.'}</p>;
  }
  if (a.status === 'PENDING') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-13 text-ink-2">
        <Tag tone="warn">PENDING</Tag>
        Waiting for {a.tier} approval.
        <Link to={`/approvals?approval=${a.id}`} className="link">
          Open approval
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-13">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tag tone={resolutionTone.approval(a.status)}>{a.status}</Tag>
        {a.decidedBy ? (
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            by <Actor actor={a.decidedBy} />
          </span>
        ) : null}
        {a.decidedAt ? <When iso={a.decidedAt} /> : null}
        <span className="font-mono text-12 text-ink-2">{a.tier} tier</span>
      </p>
      {a.comment ? <Quote>{a.comment}</Quote> : null}
    </div>
  );
}

function ExecutionTable({ steps }: { steps: readonly ExecutionStep[] }) {
  return (
    <table aria-label="Execution steps" className="w-full table-fixed border-separate border-spacing-0 border-x border-t border-rule bg-surface text-13">
      <colgroup>
        <col style={{ width: 40 }} />
        <col style={{ width: 184 }} />
        <col style={{ width: 124 }} />
        <col />
        <col style={{ width: 88 }} />
      </colgroup>
      <thead>
        <tr>
          {['#', 'Action', 'Status', 'Summary', 'Duration'].map((h, i) => (
            <th key={h} scope="col" className={`h-8 border-b border-rule bg-surface-sunk px-3 text-12 font-medium text-ink-2 ${i === 4 ? 'text-right' : 'text-left'}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.index}>
            <td className="tabular border-b border-rule px-3 py-1.5 align-top font-mono text-12 text-ink-2">{String(s.index + 1).padStart(2, '0')}</td>
            <td className="border-b border-rule px-3 py-1.5 align-top">
              <span className="block truncate" title={s.type}>
                {ACTION_META[s.type].label}
              </span>
            </td>
            <td className="border-b border-rule px-3 py-1.5 align-top">
              <Tag tone={resolutionTone.step(s.status)}>{s.status}</Tag>
            </td>
            <td className="border-b border-rule px-3 py-1.5 align-top text-ink">
              <MonoIds text={s.summary} />
              {s.error ? (
                <span className="mt-0.5 block font-mono text-12 text-bad">
                  {s.error.code}
                  <span className="text-ink-2"> · {s.error.message}</span>
                </span>
              ) : null}
            </td>
            <td className="tabular border-b border-rule px-3 py-1.5 text-right align-top font-mono text-12 text-ink-2">
              {formatDuration(s.startedAt, s.finishedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
