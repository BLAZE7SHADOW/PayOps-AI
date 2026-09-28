import { Link } from 'react-router';
import { formatMoney, formatMoneyCompact, type OverviewMetrics } from '@payops/shared';
import { plural } from '../../lib/format';
import { Skeleton } from '../../ui/Skeleton';
import type { ReactNode } from 'react';

interface Figure {
  label: string;
  value: ReactNode;
  valueTitle?: string;
  sub: ReactNode;
}

function figures(m: OverviewMetrics): Figure[] {
  const pct = m.resolved7d ? Math.round((m.resolvedByAgent7d / m.resolved7d) * 100) : 0;
  return [
    {
      label: 'Captured today',
      value: formatMoneyCompact(m.capturedTodayMinor),
      valueTitle: formatMoney(m.capturedTodayMinor),
      sub: plural(m.capturedTodayCount, 'payment'),
    },
    {
      label: 'Open exceptions',
      value: m.openExceptions.toLocaleString('en-IN'),
      sub: (
        <Link to="/exceptions" className="link">
          View queue
        </Link>
      ),
    },
    {
      label: 'Awaiting approval',
      value: m.awaitingApproval.toLocaleString('en-IN'),
      sub: (
        <Link to="/approvals" className="link">
          {m.awaitingApproval ? `Review ${plural(m.awaitingApproval, 'proposal')}` : 'Nothing waiting'}
        </Link>
      ),
    },
    {
      label: 'Resolved by investigation, 7d',
      value: m.resolvedByAgent7d.toLocaleString('en-IN'),
      sub: `${pct}% of ${plural(m.resolved7d, 'resolved case')}`,
    },
  ];
}

const LABELS = ['Captured today', 'Open exceptions', 'Awaiting approval', 'Resolved by investigation, 7d'];

/** Four figures as plain text blocks separated by hairlines. Not cards. */
export function Figures({ data }: { data: OverviewMetrics | undefined }) {
  return (
    <dl className="grid grid-cols-4 border border-rule bg-surface">
      {data
        ? figures(data).map((f, i) => (
            <div key={f.label} className={i ? 'border-l border-rule px-4 py-3' : 'px-4 py-3'}>
              <dt className="text-12 text-ink-2">{f.label}</dt>
              <dd className="tabular mt-1 font-mono text-24 font-medium text-ink" title={f.valueTitle}>
                {f.value}
              </dd>
              <dd className="mt-0.5 text-12 text-ink-2">{f.sub}</dd>
            </div>
          ))
        : LABELS.map((label, i) => (
            <div key={label} className={i ? 'border-l border-rule px-4 py-3' : 'px-4 py-3'}>
              <dt className="text-12 text-ink-2">{label}</dt>
              <dd className="mt-1 flex h-8 items-center">
                <Skeleton width={i === 0 ? 112 : 40} height={20} />
              </dd>
              <dd className="mt-0.5 flex h-4 items-center">
                <Skeleton width={88} height={10} />
              </dd>
            </div>
          ))}
    </dl>
  );
}
