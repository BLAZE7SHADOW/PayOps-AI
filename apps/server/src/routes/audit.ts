import { Router } from 'express';
import { AuditListQuery, type AuditEventItem, type Page } from '@payops/shared';
import type { Core } from '@payops/core';
import { parseQuery } from '../lib/validate';

export function auditRoutes(core: Core): Router {
  const router = Router();

  // Phase 2: requireRole('VIEWER')
  router.get('/', async (req, res) => {
    const body: Page<AuditEventItem> = await core.audit.list(parseQuery(AuditListQuery, req));
    res.json(body);
  });

  return router;
}
