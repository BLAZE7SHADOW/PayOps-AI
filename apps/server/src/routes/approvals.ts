import { Router } from 'express';
import {
  ApprovalDecisionBody,
  ApprovalListQuery,
  BulkApprovalBody,
  type ApprovalDetail,
  type ApprovalItem,
  type BulkApprovalResult,
  type Page,
} from '@payops/shared';
import type { Core } from '@payops/core';
import { requirePermission, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

export function approvalRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('approval.view'), async (req, res) => {
    const body: Page<ApprovalItem> = await core.approvals.list(parseQuery(ApprovalListQuery, req), sessionUser(req));
    res.json(body);
  });

  // Declared before '/:id' routes. Same rules as a single decision, per item (D069).
  router.post('/bulk-approve', requirePermission('approval.bulk'), async (req, res) => {
    const body: BulkApprovalResult = await core.approvals.bulkApprove(parseBody(BulkApprovalBody, req), sessionUser(req));
    res.json(body);
  });

  router.get('/:id', requirePermission('approval.view'), async (req, res) => {
    const body: ApprovalDetail = await core.approvals.get(param(req, 'id'), sessionUser(req));
    res.json(body);
  });

  // The tier's role and four-eyes are enforced by ApprovalService.
  router.post('/:id/decision', requirePermission('approval.decide'), async (req, res) => {
    const body: ApprovalItem = await core.approvals.decide(param(req, 'id'), parseBody(ApprovalDecisionBody, req), sessionUser(req));
    res.json(body);
  });

  return router;
}
