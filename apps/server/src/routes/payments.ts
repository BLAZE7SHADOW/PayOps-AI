import { Router } from 'express';
import { PaymentListQuery, type Page, type PaymentDetail, type PaymentListItem } from '@payops/shared';
import type { Core } from '@payops/core';
import { requireRole } from '../auth/middleware';
import { param, parseQuery } from '../lib/validate';

export function paymentRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const body: Page<PaymentListItem> = await core.payments.list(parseQuery(PaymentListQuery, req));
    res.json(body);
  });

  router.get('/:id', requireRole('VIEWER'), async (req, res) => {
    const body: PaymentDetail = await core.payments.get(param(req, 'id'));
    res.json(body);
  });

  return router;
}
