import { createBrowserRouter } from 'react-router';
import { AppShell } from './AppShell';
import { RequireCapability } from './RequireCapability';
import { RequireSession } from './RequireSession';
import { RouteError, NotFound } from './RouteError';

/** Each screen is its own chunk (Recharts only loads with the overview). */
export const router = createBrowserRouter([
  {
    path: '/',
    errorElement: <RouteError />,
    lazy: () => import('../features/landing/LandingRoute').then((m) => ({ Component: m.LandingRoute })),
  },
  {
    path: 'terms',
    errorElement: <RouteError />,
    lazy: () => import('../features/landing/TermsPage').then((m) => ({ Component: m.TermsPage })),
  },
  {
    path: 'privacy',
    errorElement: <RouteError />,
    lazy: () => import('../features/landing/PrivacyPage').then((m) => ({ Component: m.PrivacyPage })),
  },
  {
    path: 'login',
    errorElement: <RouteError />,
    lazy: () => import('../features/auth/LoginPage').then((m) => ({ Component: m.LoginPage })),
  },
  {
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    errorElement: <RouteError />,
    children: [
      { path: 'overview', lazy: () => import('../features/overview/OverviewPage').then((m) => ({ Component: m.OverviewPage })) },
      { path: 'payments', lazy: () => import('../features/payments/PaymentsPage').then((m) => ({ Component: m.PaymentsPage })) },
      { path: 'exceptions', lazy: () => import('../features/exceptions/ExceptionsPage').then((m) => ({ Component: m.ExceptionsPage })) },
      { path: 'cases/:caseId', lazy: () => import('../features/cases/CasePage').then((m) => ({ Component: m.CasePage })) },
      { path: 'approvals', lazy: () => import('../features/approvals/ApprovalsPage').then((m) => ({ Component: m.ApprovalsPage })) },
      {
        path: 'simulator',
        lazy: () =>
          import('../features/simulator/SimulatorPage').then((m) => ({
            Component: () => (
              <RequireCapability capability="simulate">
                <m.SimulatorPage />
              </RequireCapability>
            ),
          })),
      },
      { path: 'policy', lazy: () => import('../features/policy/PolicyPage').then((m) => ({ Component: m.PolicyPage })) },
      { path: 'runs', lazy: () => import('../features/runs/RunsPage').then((m) => ({ Component: m.RunsPage })) },
      { path: 'runs/:runId', lazy: () => import('../features/runs/RunDetailPage').then((m) => ({ Component: m.RunDetailPage })) },
      { path: 'audit', lazy: () => import('../features/audit/AuditPage').then((m) => ({ Component: m.AuditPage })) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
