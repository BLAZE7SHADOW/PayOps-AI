import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from './AppShell';
import { RouteError, NotFound } from './RouteError';

/** Each screen is its own chunk (Recharts only loads with the overview). */
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', lazy: () => import('../features/overview/OverviewPage').then((m) => ({ Component: m.OverviewPage })) },
      { path: 'payments', lazy: () => import('../features/payments/PaymentsPage').then((m) => ({ Component: m.PaymentsPage })) },
      { path: 'exceptions', lazy: () => import('../features/exceptions/ExceptionsPage').then((m) => ({ Component: m.ExceptionsPage })) },
      { path: 'cases/:caseId', lazy: () => import('../features/cases/CasePage').then((m) => ({ Component: m.CasePage })) },
      { path: 'simulator', lazy: () => import('../features/simulator/SimulatorPage').then((m) => ({ Component: m.SimulatorPage })) },
      { path: 'audit', lazy: () => import('../features/audit/AuditPage').then((m) => ({ Component: m.AuditPage })) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
