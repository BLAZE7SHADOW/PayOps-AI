import { Router } from 'express';
import { GenerateScenarioBody, SCENARIOS, type GenerateScenarioResult, type ScenarioInfo } from '@payops/shared';
import type { Core } from '@payops/core';
import { generateScenario, resetDemoData } from '@payops/simulator';
import { parseBody } from '../lib/validate';

export function simulatorRoutes(core: Core): Router {
  const router = Router();

  // Phase 2: requireRole('ADMIN') (OPS when DEMO_MODE)
  router.get('/scenarios', (_req, res) => {
    const body: readonly ScenarioInfo[] = SCENARIOS;
    res.json(body);
  });

  // Phase 2: requireRole('ADMIN') (OPS when DEMO_MODE)
  router.post('/scenarios', async (req, res) => {
    const body: GenerateScenarioResult = await generateScenario(core, parseBody(GenerateScenarioBody, req));
    res.status(201).json(body);
  });

  // Phase 2: requireRole('ADMIN') (OPS when DEMO_MODE)
  router.post('/reset', async (_req, res) => {
    await resetDemoData(core);
    res.json({ status: 'ok' });
  });

  return router;
}
