import { METRIC_DEFINITIONS, type PerformanceMetrics } from '@payops/shared';
import { plural } from '../../lib/format';
import { Skeleton } from '../../ui/Skeleton';

/** 4m, 1h 20m, 2d 3h. Durations come from code, so formatting them here is display only. */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

interface Item {
  key: keyof typeof METRIC_DEFINITIONS;
  label: string;
  value: string | null;
  sub: string;
}

function items(p: PerformanceMetrics): Item[] {
  return [
    {
      key: 'resolutionTime',
      label: 'Resolution time',
      value: p.resolutionTimeMedianMs === null ? null : formatDuration(p.resolutionTimeMedianMs),
      sub: `median, ${plural(p.resolvedCount, 'resolved case')}`,
    },
    {
      key: 'autoResolutionRate',
      label: 'Auto-resolution rate',
      value: p.autoResolutionRate === null ? null : pct(p.autoResolutionRate),
      sub: `of ${plural(p.resolvedCount, 'resolved case')}`,
    },
    {
      key: 'agentAccuracy',
      label: 'Agent accuracy',
      value: p.agentAccuracy === null ? null : pct(p.agentAccuracy),
      sub: `${plural(p.ratedCount, 'operator rating')}`,
    },
    {
      key: 'approvalTurnaround',
      label: 'Approval turnaround',
      value: p.approvalTurnaroundMedianMs === null ? null : formatDuration(p.approvalTurnaroundMedianMs),
      sub: `median, ${plural(p.decidedApprovalCount, 'decision')}`,
    },
    {
      key: 'costPerCase',
      label: 'Cost per case',
      value: p.costPerCaseUsd === null ? null : `$${p.costPerCaseUsd.toFixed(3)}`,
      sub: `${plural(p.casesWithRuns, 'case')} with a run`,
    },
  ];
}

const KEYS = ['Resolution time', 'Auto-resolution rate', 'Agent accuracy', 'Approval turnaround', 'Cost per case'];

/** Last-7-day performance. Each figure carries its definition as visible text, not a tooltip. */
export function Performance({ data }: { data: PerformanceMetrics | undefined }) {
  return (
    <dl className="grid grid-cols-1 border border-rule bg-surface sm:grid-cols-2 lg:grid-cols-5">
      {data
        ? items(data).map((f, i) => (
            <div key={f.key} className={i ? 'border-t border-rule px-4 py-3 lg:border-l lg:border-t-0' : 'px-4 py-3'}>
              <dt className="text-12 text-ink-2">{f.label}</dt>
              <dd className="tabular mt-1 font-mono text-24 font-medium text-ink">
                {f.value ?? <span className="text-14 font-normal text-ink-2">No data</span>}
              </dd>
              <dd className="mt-0.5 text-12 text-ink-2">{f.sub}</dd>
              <dd className="mt-2 text-12 text-ink-2">{METRIC_DEFINITIONS[f.key]}</dd>
            </div>
          ))
        : KEYS.map((label, i) => (
            <div key={label} className={i ? 'border-t border-rule px-4 py-3 lg:border-l lg:border-t-0' : 'px-4 py-3'}>
              <dt className="text-12 text-ink-2">{label}</dt>
              <dd className="mt-1 flex h-8 items-center">
                <Skeleton width={56} height={20} />
              </dd>
              <dd className="mt-0.5 flex h-4 items-center">
                <Skeleton width={88} height={10} />
              </dd>
            </div>
          ))}
    </dl>
  );
}
