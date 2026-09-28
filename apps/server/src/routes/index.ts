import { Router } from 'express';
import { pingDatabase, type Core, type Database } from '@payops/core';
import { auditRoutes } from './audit';
import { caseRoutes } from './cases';
import { overviewRoutes } from './overview';
import { paymentRoutes } from './payments';
import { simulatorRoutes } from './simulator';

export interface RouteDeps {
  database: Database;
  core: Core;
}

export function buildRouter(deps: RouteDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = await pingDatabase(deps.database.pool);
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', checks: { database: db ? 'ok' : 'down' } });
  });

  router.use('/overview', overviewRoutes(deps.core));
  router.use('/payments', paymentRoutes(deps.core));
  router.use('/cases', caseRoutes(deps.core));
  router.use('/simulator', simulatorRoutes(deps.core));
  router.use('/audit', auditRoutes(deps.core));

  return router;
}
