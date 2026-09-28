import { CASE_TYPE_LABEL, DETECTION_RULE_LABEL, formatMoney, type CaseDetail } from '@payops/shared';
import { Fragment, type ReactNode } from 'react';
import { formatDateTime, formatFullDateTime, statusLabel } from '../../lib/format';
import { tone } from '../../lib/status';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { Tooltip } from '../../ui/Tooltip';

const Dot = () => (
  <span aria-hidden="true" className="text-ink-3">
    ·
  </span>
);

/** One line: PAY-0042 · Payment mismatch · ₹12,499.00 · OPEN · opened 28 Sep 12:31:04 · D1, D3 */
export function CaseHeader({ c }: { c: CaseDetail }) {
  const parts: ReactNode[] = [
    <span key="type" className="text-16 text-ink">{CASE_TYPE_LABEL[c.type]}</span>,
    <span key="amt" className="tabular font-mono text-16 font-medium text-ink">{formatMoney(c.amountMinor)}</span>,
    <Tag key="status" tone={tone.caseStatus(c.status)}>{statusLabel(c.status)}</Tag>,
    <span key="opened" className="text-13 text-ink-2">
      opened{' '}
      <time dateTime={c.openedAt} title={formatFullDateTime(c.openedAt)} className="tabular font-mono">
        {formatDateTime(c.openedAt)}
      </time>
    </span>,
    <span key="rules" className="inline-flex gap-1.5">
      {c.ruleIds.map((r) => (
        <Tooltip key={r} content={DETECTION_RULE_LABEL[r]}>
          <span tabIndex={0} className="cursor-help rounded-xs font-mono text-13 text-ink-2 underline decoration-rule-strong decoration-dotted underline-offset-4">
            {r.split('_')[0]}
          </span>
        </Tooltip>
      ))}
    </span>,
  ];
  return (
    <header className="pb-4">
      <h1 className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1 text-14">
        <span className="tabular font-mono text-20 font-semibold text-ink">{c.displayId}</span>
        {parts.map((p, i) => (
          <Fragment key={i}>
            <Dot />
            {p}
          </Fragment>
        ))}
      </h1>
      <p className="mt-1 text-13 text-ink-2">
        <Tag tone={tone.severity(c.severity)}>{c.severity}</Tag>
        <span className="mx-2 text-ink-3" aria-hidden="true">·</span>
        {c.assignee ? `Assigned to ${c.assignee.name}` : 'Unassigned'}
      </p>
    </header>
  );
}

export function CaseHeaderSkeleton() {
  return (
    <header className="pb-4" aria-hidden="true">
      <div className="flex h-7 items-center gap-2.5">
        <Skeleton width={96} height={20} />
        <Skeleton width={120} height={14} />
        <Skeleton width={96} height={14} />
        <Skeleton width={56} height={14} />
        <Skeleton width={176} height={14} />
      </div>
      <div className="mt-1 flex h-5 items-center gap-2">
        <Skeleton width={56} height={14} />
        <Skeleton width={160} height={12} />
      </div>
    </header>
  );
}
