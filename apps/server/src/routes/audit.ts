import { Router } from 'express';
import { AuditListQuery, type AuditChainStatus, type AuditEventItem, type Page } from '@payops/shared';
import type { Core } from '@payops/core';
import { requirePermission, sessionUser } from '../auth/middleware';
import { parseQuery } from '../lib/validate';

const AuditExportQuery = AuditListQuery.pick({ caseId: true, entityId: true });

export function auditRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('audit.view'), async (req, res) => {
    const body: Page<AuditEventItem> = await core.audit.list(parseQuery(AuditListQuery, req));
    res.json(body);
  });

  // Walks the whole hash chain. Optional ?headSeq=&headHash= is a head saved from an earlier export or check.
  router.get('/verify', requirePermission('audit.verify'), async (req, res) => {
    const seq = Number(req.query.headSeq);
    const hash = typeof req.query.headHash === 'string' ? req.query.headHash : '';
    const head = Number.isInteger(seq) && seq > 0 && hash ? { seq, hash } : undefined;
    const body: AuditChainStatus = await core.audit.verifyChain(head);
    res.json(body);
  });

  // The export is itself audited first, so the file shows who took it.
  router.get('/export.csv', requirePermission('audit.verify'), async (req, res) => {
    const filter = parseQuery(AuditExportQuery, req);
    const me = sessionUser(req);
    await core.audit.record({
      actorType: 'USER',
      actorId: me.id,
      actorName: me.name,
      action: 'audit.exported',
      entityType: 'system',
      entityId: 'audit-log',
      summary: `${me.name} exported the audit log as CSV`,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payops-audit-log.csv"');
    for await (const line of core.audit.exportCsv(filter)) res.write(line);
    res.end();
  });

  return router;
}
