import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSession } from '../lib/session';
import { ErrorState } from '../ui/ErrorState';
import { ShellSkeleton } from './ShellSkeleton';

/**
 * Auth guard for every app route. While /api/auth/me resolves, the shell's own skeleton shows
 * (no spinner, no flash of the login page). No session sends the user to /login?next=<path>.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const { pathname, search } = useLocation();

  if (session.isPending) return <ShellSkeleton />;
  if (session.isError) {
    return (
      <main className="min-h-screen bg-paper p-6">
        <ErrorState title="Could not check your session." error={session.error} onRetry={() => void session.refetch()} />
      </main>
    );
  }
  if (!session.data) {
    const next = `${pathname}${search}`;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
