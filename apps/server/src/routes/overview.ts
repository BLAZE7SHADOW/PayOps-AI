import { Router } from 'express';
import type { OverviewMetrics } from '@payops/shared';
import type { Core } from '@payops/core';
import { requirePermission } from '../auth/middleware';

export function overviewRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('overview.view'), async (_req, res) => {
    const body: OverviewMetrics = await core.overview.metrics();
    res.json(body);
  });

  return router;
}
