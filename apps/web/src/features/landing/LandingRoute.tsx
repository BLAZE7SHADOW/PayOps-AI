import { Navigate } from 'react-router';
import { useSession } from '../../lib/session';
import { ShellSkeleton } from '../../app/ShellSkeleton';
import { LandingPage } from './LandingPage';

/** `/`: signed-in people go straight to the app, everyone else sees the landing page. */
export function LandingRoute() {
  const session = useSession();
  if (session.isPending) return <ShellSkeleton />;
  if (session.data) return <Navigate to="/overview" replace />;
  return <LandingPage />;
}
