import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CaseDetail } from '@payops/shared';
import { can, VIEW_ONLY_NOTE } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { activeRun, useRuns, useStartRun } from '../investigation/api';
import { ResolveDrawer } from '../resolution/ResolveDrawer';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Tag } from '../../ui/Tag';

/** A single place for the next permitted case action. Server permissions still decide what runs. */
export function CaseActions({ c }: { c: CaseDetail }) {
  const user = useUser();
  const runs = useRuns(c.id);
  const start = useStartRun(c.id);
  const [manualOpen, setManualOpen] = useState(false);
  const mayResolve = can(user?.role, 'resolve');
  const mayPropose = mayResolve && c.resolutionView.canPropose;
  const busy = runs.data?.items.some((r) => activeRun(r.status) || r.status === 'AWAITING_APPROVAL') ?? false;
  const mayStart = mayPropose && c.status !== 'RESOLVED' && !busy && !runs.isPending && !runs.isError && !start.isPending;
  const approvalId = c.resolutionView.pendingApprovalId;
  const lastValidation = c.resolutionView.resolutions.find((r) => r.validation)?.validation;

  useEffect(() => {
    if (!mayPropose) setManualOpen(false);
  }, [mayPropose]);

  let title = 'Review this case';
  let description = 'The current records and history are available for review.';
  if (c.status === 'RESOLVED') {
    title = 'Resolution verified';
    description = 'The resolution history and validator results are available below.';
  } else if (approvalId || c.status === 'AWAITING_APPROVAL') {
    title = 'Approval required';
    description = 'Review the proposed operation, evidence, and policy before a decision.';
  } else if (c.status === 'EXECUTING') {
    title = 'Resolution in progress';
    description = 'Execution and independent verification are running.';
  } else if (busy || c.status === 'INVESTIGATING') {
    title = 'Investigation in progress';
    description = 'Evidence and findings will update as the investigation runs.';
  } else if (mayStart) {
    title = c.status === 'ESCALATED' || c.status === 'REJECTED' ? 'Review the next step' : 'Investigate the mismatch';
    description = 'Collect evidence and receive a proposed resolution, or choose actions manually.';
  } else if (!mayResolve) {
    description = VIEW_ONLY_NOTE;
  } else if (!c.resolutionView.canPropose) {
    description = c.resolutionView.cannotProposeReason ?? description;
  }

  return (
    <aside className="min-w-0 self-start rounded-lg border border-rule bg-surface p-5 lg:p-6" aria-labelledby="case-action-title">
      <p className="text-12 font-semibold tracking-wide text-ink-2 uppercase">Next step</p>
      <h2 id="case-action-title" className="mt-2 text-20 font-semibold text-ink">{title}</h2>
      <p className="mt-3 text-14 leading-6 text-ink-2">{description}</p>

      <div className="mt-5 flex flex-col gap-2">
        {c.status === 'RESOLVED' ? (
          <Link to="/exceptions" className="transition-color inline-flex min-h-10 items-center justify-center rounded-md border border-control bg-surface px-4 text-14 font-medium text-ink hover:bg-surface-sunk max-md:min-h-11">Back to Exceptions</Link>
        ) : approvalId ? (
          <Link to={`/approvals?approval=${encodeURIComponent(approvalId)}`} className="transition-color inline-flex min-h-10 items-center justify-center rounded-md border border-accent bg-accent px-4 text-14 font-medium text-surface hover:bg-accent-hover max-md:min-h-11">Review approval</Link>
        ) : mayStart ? (
          <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? 'Starting investigation…' : 'Start investigation'}
          </Button>
        ) : null}
        {mayPropose && c.status !== 'RESOLVED' ? <Button variant="secondary" onClick={() => setManualOpen(true)}>Resolve manually</Button> : null}
      </div>

      {lastValidation && c.status === 'RESOLVED' ? <p className="mt-5 border-t border-rule pt-4 text-13 text-ink-2">Independent verification <Tag tone={lastValidation.verdict === 'PASS' ? 'ok' : 'bad'}>{lastValidation.verdict}</Tag></p> : null}
      {approvalId ? <p className="mt-5 border-t border-rule pt-4 text-13 text-ink-2">Approvals use the existing role and requester checks.</p> : null}
      {start.isError && mayStart ? <ErrorState className="mt-4" title="Could not start investigation." error={start.error} onRetry={() => start.mutate()} /> : null}
      {runs.isError ? <ErrorState className="mt-4" title="Could not load investigations." error={runs.error} onRetry={() => void runs.refetch()} /> : null}
      {mayResolve ? <ResolveDrawer c={c} open={manualOpen && mayPropose} onOpenChange={setManualOpen} /> : null}
    </aside>
  );
}
