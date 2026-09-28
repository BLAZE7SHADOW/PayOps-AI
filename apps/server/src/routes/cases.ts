import { Router } from 'express';
import {
  CaseListQuery,
  PreviewActionsBody,
  ProposeActionsBody,
  type CaseDetail,
  type CaseListItem,
  type Page,
  type PolicyPreview,
  type ResolutionItem,
} from '@payops/shared';
import type { Core } from '@payops/core';
import { requireRole, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

export function caseRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const body: Page<CaseListItem> = await core.cases.list(parseQuery(CaseListQuery, req));
    res.json(body);
  });

  router.get('/:id', requireRole('VIEWER'), async (req, res) => {
    const body: CaseDetail = await core.cases.get(param(req, 'id'), sessionUser(req));
    res.json(body);
  });

  router.post('/:id/actions/preview', requireRole('OPS'), async (req, res) => {
    const { actions } = parseBody(PreviewActionsBody, req);
    const body: PolicyPreview = await core.resolutions.preview(param(req, 'id'), actions, sessionUser(req));
    res.json(body);
  });

  router.post('/:id/actions', requireRole('OPS'), async (req, res) => {
    const body: ResolutionItem = await core.resolutions.propose(param(req, 'id'), parseBody(ProposeActionsBody, req), sessionUser(req));
    res.status(201).json(body);
  });

  return router;
}
