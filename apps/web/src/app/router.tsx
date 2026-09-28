import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from './AppShell';
import { RequireCapability } from './RequireCapability';
import { RequireSession } from './RequireSession';
import { RouteError, NotFound } from './RouteError';

/** Each screen is its own chunk (Recharts only loads with the overview). */
export const router = createBrowserRouter([
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
      { index: true, element: <Navigate to="/overview" replace /> },
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
      { path: 'audit', lazy: () => import('../features/audit/AuditPage').then((m) => ({ Component: m.AuditPage })) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
