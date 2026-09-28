import { Router } from 'express';
import { CaseListQuery, type CaseDetail, type CaseListItem, type Page } from '@payops/shared';
import type { Core } from '@payops/core';
import { param, parseQuery } from '../lib/validate';

export function caseRoutes(core: Core): Router {
  const router = Router();

  // Phase 2: requireRole('VIEWER')
  router.get('/', async (req, res) => {
    const body: Page<CaseListItem> = await core.cases.list(parseQuery(CaseListQuery, req));
    res.json(body);
  });

  // Phase 2: requireRole('VIEWER')
  router.get('/:id', async (req, res) => {
    const body: CaseDetail = await core.cases.get(param(req, 'id'));
    res.json(body);
  });

  return router;
}
