import { Router } from 'express';
import { GenerateScenarioBody, SCENARIOS, type GenerateScenarioResult, type ScenarioInfo } from '@payops/shared';
import type { Core, ServerEnv } from '@payops/core';
import { requireRole } from '../auth/middleware';
import { generateScenario, resetDemoData } from '@payops/simulator';
import { parseBody } from '../lib/validate';

export function simulatorRoutes(core: Core, env: Pick<ServerEnv, 'DEMO_MODE'>): Router {
  const router = Router();
  // ADMIN only, or OPS in demo mode so visitors can generate scenarios.
  router.use(requireRole(env.DEMO_MODE ? 'OPS' : 'ADMIN'));

  router.get('/scenarios', (_req, res) => {
    const body: readonly ScenarioInfo[] = SCENARIOS;
    res.json(body);
  });

  router.post('/scenarios', async (req, res) => {
    const body: GenerateScenarioResult = await generateScenario(core, parseBody(GenerateScenarioBody, req));
    res.status(201).json(body);
  });

  router.post('/reset', async (_req, res) => {
    await resetDemoData(core);
    res.json({ status: 'ok' });
  });

  return router;
}
