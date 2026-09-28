import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { CASE_TYPES, CASE_TYPE_LABEL, type CaseType, type OverviewMetrics } from '@payops/shared';
import { formatDay } from '../../lib/format';
import { useTokenValues } from '../../lib/use-tokens';
import { Skeleton } from '../../ui/Skeleton';

type Row = OverviewMetrics['exceptionsByType'][number];

const TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'rule', 'ink-2', 'surface', 'surface-sunk'] as const;
/** Color follows the case type, never its rank, so a filter never repaints a series. */
const SERIES: Record<CaseType, (typeof TOKENS)[number]> = {
  PAYMENT_MISMATCH: 'chart-1',
  REFUND_EXCEPTION: 'chart-2',
  SETTLEMENT_MISMATCH: 'chart-3',
  RISK_CASE: 'chart-4',
  DUPLICATE: 'chart-5',
};

const HEIGHT = 224;

export function ExceptionsChart({ data }: { data: Row[] }) {
  const t = useTokenValues(TOKENS);
  const totals = CASE_TYPES.map((type) => ({ type, total: data.reduce((s, r) => s + (r[type] ?? 0), 0) }));
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 11, fill: t['ink-2'] };

  return (
    <div>
      {/* Inline legend with 14-day totals: identity never depends on color alone. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-12 text-ink-2">
        {totals.map(({ type, total }) => (
          <li key={type} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2" style={{ background: t[SERIES[type]] }} />
            {CASE_TYPE_LABEL[type]}
            <span className="tabular font-mono text-ink">{total}</span>
          </li>
        ))}
      </ul>
      <div className="px-2 pt-2 pb-2" style={{ height: HEIGHT }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={t.rule} strokeDasharray="0" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              tick={mono}
              tickLine={false}
              axisLine={{ stroke: t.rule }}
              interval={1}
              tickMargin={6}
            />
            <YAxis allowDecimals={false} tick={mono} tickLine={false} axisLine={false} width={32} tickCount={4} />
            <Tooltip cursor={{ fill: t['surface-sunk'] }} content={<ChartTooltip colors={t} />} isAnimationActive={false} />
            {CASE_TYPES.map((type) => (
              <Bar
                key={type}
                dataKey={type}
                name={CASE_TYPE_LABEL[type]}
                stackId="cases"
                fill={t[SERIES[type]]}
                stroke={t.surface}
                strokeWidth={1}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Exceptions opened per day by type, last 14 days</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            {CASE_TYPES.map((type) => (
              <th key={type} scope="col">
                {CASE_TYPE_LABEL[type]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.date}>
              <th scope="row">{formatDay(r.date)}</th>
              {CASE_TYPES.map((type) => (
                <td key={type}>{r[type] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartTooltip({ active, payload, label, colors }: TooltipProps<number, string> & { colors: Record<string, string> }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div className="min-w-48 rounded-sm border border-rule bg-surface px-3 py-2 text-12 shadow-pop">
      <p className="tabular mb-1 flex justify-between font-mono text-ink">
        <span>{formatDay(String(label))}</span>
        <span>{total}</span>
      </p>
      {[...payload].reverse().map((p) => (
        <p key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2" style={{ background: colors[SERIES[p.dataKey as CaseType]] }} />
            {p.name}
          </span>
          <span className="tabular font-mono text-ink">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export function ExceptionsChartSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex gap-4 px-4 pt-3">
        {CASE_TYPES.map((t) => (
          <span key={t} className="flex h-4 items-center">
            <Skeleton width={96} height={10} />
          </span>
        ))}
      </div>
      <div className="flex items-end gap-[2%] px-12 pt-4 pb-8" style={{ height: HEIGHT }}>
        {Array.from({ length: 14 }, (_, i) => (
          <Skeleton key={i} width="5%" height={40 + ((i * 37) % 110)} />
        ))}
      </div>
    </div>
  );
}
