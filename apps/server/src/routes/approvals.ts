import { Router } from 'express';
import { ApprovalDecisionBody, ApprovalListQuery, type ApprovalDetail, type ApprovalItem, type Page } from '@payops/shared';
import type { Core } from '@payops/core';
import { requireRole, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

export function approvalRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const body: Page<ApprovalItem> = await core.approvals.list(parseQuery(ApprovalListQuery, req), sessionUser(req));
    res.json(body);
  });

  router.get('/:id', requireRole('VIEWER'), async (req, res) => {
    const body: ApprovalDetail = await core.approvals.get(param(req, 'id'), sessionUser(req));
    res.json(body);
  });

  // The tier's role and four-eyes are enforced by ApprovalService.
  router.post('/:id/decision', requireRole('OPS'), async (req, res) => {
    const body: ApprovalItem = await core.approvals.decide(param(req, 'id'), parseBody(ApprovalDecisionBody, req), sessionUser(req));
    res.json(body);
  });

  return router;
}
