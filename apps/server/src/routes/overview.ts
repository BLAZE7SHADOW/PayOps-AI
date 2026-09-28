import { Router } from 'express';
import type { OverviewMetrics } from '@payops/shared';
import type { Core } from '@payops/core';

export function overviewRoutes(core: Core): Router {
  const router = Router();

  // Phase 2: requireRole('VIEWER')
  router.get('/', async (_req, res) => {
    const body: OverviewMetrics = await core.overview.metrics();
    res.json(body);
  });

  return router;
}
