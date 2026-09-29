import { CASE_TYPE_LABEL, dueLabel, formatMoney, type CaseDetail } from '@payops/shared';
import { can } from '../../lib/permissions';
import { useSession } from '../../lib/session';
import { Button } from '../../ui/Button';
import { useAssignCase } from './api';
import { formatDateTime, formatFullDateTime, statusLabel } from '../../lib/format';
import { tone } from '../../lib/status';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';

const CLOSED: readonly string[] = ['RESOLVED', 'REJECTED'];

/** Case identity, problem type, amount, and status lead; rule codes live in details below. */
export function CaseHeader({ c }: { c: CaseDetail }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div>
        <p className="tabular font-mono text-13 text-ink-2">{c.displayId}</p>
        <h1 className="mt-1 text-28 font-semibold tracking-[-0.02em] text-ink">{CASE_TYPE_LABEL[c.type]}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-13 text-ink-2">
          <Tag tone={tone.caseStatus(c.status)}>{statusLabel(c.status)}</Tag>
          <Tag tone={tone.severity(c.severity)}>{c.severity}</Tag>
          <span>Opened <time dateTime={c.openedAt} title={formatFullDateTime(c.openedAt)} className="tabular font-mono">{formatDateTime(c.openedAt)}</time></span>
          {c.dueAt && !CLOSED.includes(c.status) ? (
            <span>
              Due <time dateTime={c.dueAt} title={formatFullDateTime(c.dueAt)} className={`tabular font-mono ${c.overdue ? 'text-bad' : ''}`}>{dueLabel(c.dueAt)}</time>
            </span>
          ) : null}
          <Assignment c={c} />
        </div>
      </div>
      <div className="text-left sm:text-right">
        <p className="tabular font-mono text-24 font-semibold text-ink">{formatMoney(c.amountMinor)}</p>
        <p className="mt-1 text-12 text-ink-2">Case amount</p>
      </div>
    </header>
  );
}

export function CaseHeaderSkeleton() {
  return (
    <header className="pb-6" aria-hidden="true">
      <div className="flex h-9 items-center gap-2.5">
        <Skeleton width={96} height={20} />
        <Skeleton width={160} height={24} />
      </div>
      <div className="mt-3 flex h-5 items-center gap-2">
        <Skeleton width={56} height={14} />
        <Skeleton width={160} height={12} />
      </div>
    </header>
  );
}

/** Wires the assignment control to the session and the assign mutation. */
function Assignment({ c }: { c: CaseDetail }) {
  const me = useSession().data;
  const assign = useAssignCase(c.id);
  return (
    <AssignmentView
      assignee={c.assignee}
      meId={me?.id ?? null}
      canAssign={Boolean(me && can(me.role, 'assign')) && !CLOSED.includes(c.status)}
      pending={assign.isPending}
      failed={assign.isError}
      onAssign={(id) => assign.mutate(id)}
    />
  );
}

interface AssignmentViewProps {
  assignee: CaseDetail['assignee'];
  meId: string | null;
  /** Already false for viewers and for closed cases. */
  canAssign: boolean;
  pending: boolean;
  failed: boolean;
  onAssign: (assigneeId: string | null) => void;
}

/** Who owns the case, with one-click take and hand back. */
export function AssignmentView({ assignee, meId, canAssign, pending, failed, onAssign }: AssignmentViewProps) {
  const mine = meId !== null && assignee?.id === meId;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{assignee ? `Assigned to ${mine ? 'you' : assignee.name}` : 'Unassigned'}</span>
      {canAssign && meId && !mine ? (
        <Button variant="quiet" size="sm" disabled={pending} onClick={() => onAssign(meId)}>
          {assignee ? 'Take over' : 'Assign to me'}
        </Button>
      ) : null}
      {canAssign && mine ? (
        <Button variant="quiet" size="sm" disabled={pending} onClick={() => onAssign(null)}>
          Unassign
        </Button>
      ) : null}
      {failed ? <span role="alert" className="text-bad">Could not change the assignee.</span> : null}
    </span>
  );
}
