import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import type { OverviewMetrics } from '@payops/shared';
import { api } from '../lib/api';
import { qk } from '../lib/query-keys';
import { cx } from '../ui/cx';

const MAIN = [
  { to: '/overview', label: 'Overview' },
  { to: '/payments', label: 'Payments' },
  { to: '/exceptions', label: 'Exceptions', count: 'openExceptions' as const },
  { to: '/audit', label: 'Audit log' },
];

export function Nav() {
  // Shares the overview cache; realtime events invalidate it so the count stays current.
  const { data } = useQuery({ queryKey: qk.overview(), queryFn: ({ signal }) => api<OverviewMetrics>('/api/overview', { signal }) });
  return (
    <nav aria-label="Primary" className="flex min-h-0 flex-col border-r border-rule bg-paper">
      <div className="flex h-12 shrink-0 items-center border-b border-rule px-4">
        <span className="text-14 font-semibold tracking-[-0.005em] text-ink">PayOps</span>
        <span className="ml-1.5 text-14 text-ink-2">AI</span>
      </div>
      <ul className="flex flex-col gap-px px-2 pt-3">
        {MAIN.map((item) => (
          <li key={item.to}>
            <Item to={item.to} label={item.label} count={item.count && data ? data[item.count] : undefined} />
          </li>
        ))}
      </ul>
      <ul className="mt-auto flex flex-col gap-px border-t border-rule px-2 py-3">
        <li>
          <Item to="/simulator" label="Simulator" />
        </li>
      </ul>
    </nav>
  );
}

function Item({ to, label, count }: { to: string; label: string; count?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'transition-color flex h-8 items-center justify-between rounded-xs px-2 text-14',
          isActive ? 'bg-accent-weak font-medium text-ink' : 'text-ink-2 hover:bg-surface-sunk hover:text-ink',
        )
      }
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span className="tabular font-mono text-12 text-ink-2" aria-label={`${count} open`}>
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}
