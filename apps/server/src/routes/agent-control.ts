/**
 * The operator's agent switch (P1 task 4, D066): read by everyone signed in, changed by managers.
 */
import { Router } from 'express';
import type { Core } from '@payops/core';
import { AgentControlBody, type AgentControlItem } from '@payops/shared';
import { requirePermission, sessionUser } from '../auth/middleware';
import { parseBody } from '../lib/validate';

export function agentControlRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requirePermission('agent.view'), async (_req, res) => {
    const body: AgentControlItem = await core.agentControl.get();
    res.json(body);
  });

  router.put('/', requirePermission('agent.control'), async (req, res) => {
    const body: AgentControlItem = await core.agentControl.set(parseBody(AgentControlBody, req), sessionUser(req));
    res.json(body);
  });

  return router;
}
