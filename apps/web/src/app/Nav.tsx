import { useQuery } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router';
import type { OverviewMetrics } from '@payops/shared';
import { api } from '../lib/api';
import { ROLE_LABEL, can } from '../lib/permissions';
import { qk } from '../lib/query-keys';
import { useLogout, useUser } from '../lib/session';
import { Tag } from '../ui/Tag';
import { cx } from '../ui/cx';

type CountKey = 'openExceptions' | 'awaitingApproval';

const MAIN: Array<{ to: string; label: string; count?: CountKey; countLabel?: string }> = [
  { to: '/overview', label: 'Overview' },
  { to: '/payments', label: 'Payments' },
  { to: '/exceptions', label: 'Exceptions', count: 'openExceptions', countLabel: 'open' },
  { to: '/approvals', label: 'Approvals', count: 'awaitingApproval', countLabel: 'pending' },
  { to: '/audit', label: 'Audit log' },
];

export function Nav() {
  const user = useUser();
  // Shares the overview cache; realtime events invalidate it so the counts stay current.
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
            <Item to={item.to} label={item.label} count={item.count && data ? data[item.count] : undefined} countLabel={item.countLabel} />
          </li>
        ))}
      </ul>
      <ul className="mt-auto flex flex-col gap-px border-t border-rule px-2 py-3">
        {can(user?.role, 'simulate') ? (
          <li>
            <Item to="/simulator" label="Simulator" />
          </li>
        ) : null}
        <li>
          <Item to="/policy" label="Policy" />
        </li>
      </ul>
      <UserMenu />
    </nav>
  );
}

function Item({ to, label, count, countLabel }: { to: string; label: string; count?: number; countLabel?: string }) {
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
        <span className="tabular font-mono text-12 text-ink-2" aria-label={`${count} ${countLabel ?? ''}`.trim()}>
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}

/** Who is signed in, their role, and sign out. Bottom of the nav (docs/05 §10). */
function UserMenu() {
  const user = useUser();
  const logout = useLogout();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="border-t border-rule px-4 py-3">
      <p className="truncate text-13 font-medium text-ink" title={user.email}>
        {user.name}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <Tag tone="neutral" title={ROLE_LABEL[user.role]}>
          {user.role}
        </Tag>
        <button
          type="button"
          disabled={logout.isPending}
          onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
          className="transition-color rounded-xs px-1 text-12 text-ink-2 hover:text-ink disabled:opacity-55"
        >
          {logout.isPending ? 'Signing out' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}
