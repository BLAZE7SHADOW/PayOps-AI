import { Router } from 'express';
import { WebhookLogListQuery, type Page, type WebhookLogCounts, type WebhookLogDetail, type WebhookLogItem } from '@payops/shared';
import type { Core } from '@payops/core';
import { requirePermission, sessionUser } from '../auth/middleware';
import { param, parseQuery } from '../lib/validate';

/** Raw inbound webhook log (P3 task 2, D072). Anyone can read it; replaying needs an OPS role. */
export function webhookRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('webhook.view'), async (req, res) => {
    const body: Page<WebhookLogItem> = await core.webhookEvents.list(parseQuery(WebhookLogListQuery, req));
    res.json(body);
  });

  router.get('/counts', requirePermission('webhook.view'), async (_req, res) => {
    const body: WebhookLogCounts = await core.webhookEvents.counts();
    res.json(body);
  });

  router.get('/:id', requirePermission('webhook.view'), async (req, res) => {
    const body: WebhookLogDetail = await core.webhookEvents.get(param(req, 'id'));
    res.json(body);
  });

  router.post('/:id/replay', requirePermission('webhook.replay'), async (req, res) => {
    const user = sessionUser(req);
    const body: WebhookLogDetail = await core.webhookEvents.replay(param(req, 'id'), { id: user.id, name: user.name });
    res.json(body);
  });

  return router;
}
