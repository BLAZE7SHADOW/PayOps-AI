import { Router } from 'express';
import { AuditListQuery, type AuditEventItem, type Page } from '@payops/shared';
import type { Core } from '@payops/core';
import { requirePermission } from '../auth/middleware';
import { parseQuery } from '../lib/validate';

export function auditRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('audit.view'), async (req, res) => {
    const body: Page<AuditEventItem> = await core.audit.list(parseQuery(AuditListQuery, req));
    res.json(body);
  });

  return router;
}
