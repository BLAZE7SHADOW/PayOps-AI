import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CaseDetail, ResolutionItem } from '@payops/shared';
import { statusLabel } from '../../lib/format';
import { VIEW_ONLY_NOTE, can } from '../../lib/permissions';
import { attemptLabel } from '../../lib/resolution';
import { useUser } from '../../lib/session';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { AttemptBlock } from './AttemptBlock';
import { Actor, Ago } from './parts';
import { ResolveDrawer } from './ResolveDrawer';

/** Full-width Resolution section under the case columns: manual path, pending approval, attempts. */
export function ResolutionSection({ c }: { c: CaseDetail | undefined }) {
  const user = useUser();
  const [open, setOpen] = useState(false);
  const view = c?.resolutionView;
  const attempts = view ? [...view.resolutions].sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt)) : [];
  const pending = view?.pendingApprovalId ? attempts.find((r) => r.approval?.id === view.pendingApprovalId) : undefined;
  const mayResolve = can(user?.role, 'resolve');
  const canPropose = Boolean(view?.canPropose);

  // A proposal that runs immediately makes the case busy (canPropose=false). Close the drawer so it
  // does not reappear on its own when the case becomes proposable again after verification.
  useEffect(() => {
    if (!canPropose) setOpen(false);
  }, [canPropose]);

  return (
    <section aria-labelledby="resolution-title" className="mt-6 border border-rule bg-surface">
      <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-4 py-2">
        <h2 id="resolution-title" className="text-13 font-semibold text-ink">
          Resolution
        </h2>
        <p className="text-12 text-ink-2">{c ? statusSummary(attempts) : <Skeleton width={160} />}</p>
        <div className="ml-auto flex items-center gap-3">
          {!c ? (
            <Skeleton width={128} height={32} />
          ) : !mayResolve ? (
            <p className="text-12 text-ink-2">{VIEW_ONLY_NOTE}</p>
          ) : view?.canPropose ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              Resolve manually
            </Button>
          ) : (
            <p className="text-12 text-ink-2">{view?.cannotProposeReason ?? 'Manual resolution is not available right now.'}</p>
          )}
        </div>
      </header>

      {pending?.approval ? <PendingLine r={pending} /> : null}

      {!c ? (
        <AttemptSkeleton />
      ) : attempts.length === 0 ? (
        <p className="px-4 py-4 text-13 text-ink-2">
          No resolution proposed yet.
          {mayResolve && view?.canPropose ? ' Use Resolve manually to pick actions from the catalog.' : ''}
        </p>
      ) : attempts.length === 1 ? (
        <AttemptBlock r={attempts[0]!} />
      ) : (
        <Attempts attempts={attempts} />
      )}

      {c && mayResolve ? <ResolveDrawer c={c} open={open && canPropose} onOpenChange={setOpen} /> : null}
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
