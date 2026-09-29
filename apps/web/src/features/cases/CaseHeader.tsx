import { CASE_TYPE_LABEL, formatMoney, type CaseDetail } from '@payops/shared';
import { formatDateTime, formatFullDateTime, statusLabel } from '../../lib/format';
import { tone } from '../../lib/status';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';

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
          <span>{c.assignee ? `Assigned to ${c.assignee.name}` : 'Unassigned'}</span>
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
