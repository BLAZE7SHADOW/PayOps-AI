import { Router } from 'express';
import { pingDatabase, type Core, type Database, type ServerEnv } from '@payops/core';
import type { SessionConfig } from '../auth/session';
import { approvalRoutes } from './approvals';
import { authRoutes } from './auth';
import { policyRoutes } from './policy';
import { auditRoutes } from './audit';
import { caseRoutes } from './cases';
import { overviewRoutes } from './overview';
import { paymentRoutes } from './payments';
import { simulatorRoutes } from './simulator';

export interface RouteDeps {
  database: Database;
  core: Core;
}

interface RouterDeps extends RouteDeps {
  env: ServerEnv;
  session: SessionConfig;
}

export function buildRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = await pingDatabase(deps.database.pool);
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', checks: { database: db ? 'ok' : 'down' } });
  });

  router.use('/auth', authRoutes(deps.core, deps.env, deps.session));
  router.use('/overview', overviewRoutes(deps.core));
  router.use('/payments', paymentRoutes(deps.core));
  router.use('/cases', caseRoutes(deps.core));
  router.use('/simulator', simulatorRoutes(deps.core, deps.env));
  router.use('/audit', auditRoutes(deps.core));
  router.use('/approvals', approvalRoutes(deps.core));
  router.use('/policy', policyRoutes());

  return router;
}
