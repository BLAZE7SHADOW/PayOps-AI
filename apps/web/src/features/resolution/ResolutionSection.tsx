import { useState } from 'react';
import { Link } from 'react-router';
import type { CaseDetail, ResolutionItem } from '@payops/shared';
import { statusLabel } from '../../lib/format';
import { attemptLabel } from '../../lib/resolution';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { AttemptBlock } from './AttemptBlock';
import { Actor, Ago } from './parts';

/** Resolution history under the case workspace; the next action lives in CaseActions. */
export function ResolutionSection({ c }: { c: CaseDetail | undefined }) {
  const view = c?.resolutionView;
  const attempts = view ? [...view.resolutions].sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt)) : [];
  const pending = view?.pendingApprovalId ? attempts.find((r) => r.approval?.id === view.pendingApprovalId) : undefined;

  return (
    <section id="resolution" aria-labelledby="resolution-title" className="mt-8 scroll-mt-6 overflow-hidden rounded-lg border border-rule bg-surface">
      <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-5 py-3">
        <h2 id="resolution-title" className="text-18 font-semibold text-ink">
          Resolution
        </h2>
        <p className="text-13 text-ink-2">{c ? statusSummary(attempts) : <Skeleton width={160} />}</p>
      </header>

      {pending?.approval ? <PendingLine r={pending} /> : null}

      {!c ? (
        <AttemptSkeleton />
      ) : attempts.length === 0 ? (
        <p className="px-5 py-5 text-14 text-ink-2">
          No resolution proposed yet.
        </p>
      ) : attempts.length === 1 ? (
        <AttemptBlock r={attempts[0]!} />
      ) : (
        <Attempts attempts={attempts} />
      )}

    </section>
  );
}

function Attempts({ attempts }: { attempts: ResolutionItem[] }) {
  const [tab, setTab] = useState(attempts[0]!.id);
  // A new attempt arriving over the socket should not strand the user on a vanished tab.
  const value = attempts.some((a) => a.id === tab) ? tab : attempts[0]!.id;
  return (
    <div className="pt-1">
      <Tabs label="Resolution attempts" value={value} onChange={setTab} tabs={attempts.map((r) => ({ value: r.id, label: attemptLabel(r), content: <AttemptBlock r={r} /> }))} />
    </div>
  );
}

function statusSummary(attempts: ResolutionItem[]): string {
  const latest = attempts[0];
  if (!latest) return 'Open. Nothing proposed.';
  const n = attempts.length;
  const verdict = latest.validation ? ` · verified ${latest.validation.verdict}` : '';
  return `${n} ${n === 1 ? 'attempt' : 'attempts'} · latest ${statusLabel(latest.status)}${verdict}`;
}

function PendingLine({ r }: { r: ResolutionItem }) {
  const a = r.approval!;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule bg-warn-weak px-4 py-2 text-13 text-warn">
      <span className="font-medium">Waiting for {a.tier} approval</span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        requested by <Actor actor={r.proposedBy} /> <Ago iso={r.createdAt} />
      </span>
      <Link to={`/approvals?approval=${a.id}`} className="link ml-auto">
        Open approval
      </Link>
    </p>
  );
}

function AttemptSkeleton() {
  return (
    <div aria-hidden="true" className="px-4 pt-3 pb-4">
      <div className="flex h-5 items-center gap-3">
        <Skeleton width={72} />
        <Skeleton width={96} height={16} />
        <Skeleton width={160} />
      </div>
      <div className="mt-4 grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-x-6">
        <Skeleton height={72} />
        <Skeleton height={72} />
      </div>
      <Skeleton height={96} className="mt-4" />
    </div>
  );
}
