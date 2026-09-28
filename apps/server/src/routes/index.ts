import { Router } from 'express';
import { pingDatabase, type Database } from '@payops/core';

export interface RouteDeps {
  database: Database;
}

export function buildRouter(deps: RouteDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = await pingDatabase(deps.database.pool);
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', checks: { database: db ? 'ok' : 'down' } });
  });

  return router;
}
