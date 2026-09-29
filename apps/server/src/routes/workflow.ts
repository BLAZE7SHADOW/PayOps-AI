import { Router } from 'express';
import { HandoffQuery, SavedViewBody, type HandoffSummary, type Page, type SavedViewItem } from '@payops/shared';
import type { Core } from '@payops/core';
import { requireRole, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

/** Saved views are per user, so every role that can see the queue can keep its own. */
export function savedViewRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const items = await core.savedViews.list(sessionUser(req).id);
    const body: Page<SavedViewItem> = { items, nextCursor: null, total: items.length };
    res.json(body);
  });

  router.post('/', requireRole('VIEWER'), async (req, res) => {
    const body: SavedViewItem = await core.savedViews.save(sessionUser(req).id, parseBody(SavedViewBody, req));
    res.status(201).json(body);
  });

  router.delete('/:id', requireRole('VIEWER'), async (req, res) => {
    await core.savedViews.remove(sessionUser(req).id, param(req, 'id'));
    res.status(204).end();
  });

  return router;
}

export function handoffRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const { hours } = parseQuery(HandoffQuery, req);
    const body: HandoffSummary = await core.handoff.summary(hours);
    res.json(body);
  });

  return router;
}
