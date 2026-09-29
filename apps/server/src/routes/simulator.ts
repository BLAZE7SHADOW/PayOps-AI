import { Router } from 'express';
import { GenerateScenarioBody, SCENARIOS, type GenerateScenarioResult, type ScenarioInfo } from '@payops/shared';
import type { Core, ServerEnv } from '@payops/core';
import { requireRole } from '../auth/middleware';
import { generateScenario, resetDemoData, snapshotDemoData, undoLastReset, undoStatus } from '@payops/simulator';
import { AppError, DEFAULT_CASSETTE_DIR } from '@payops/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBody } from '../lib/validate';

// Tests reset repeatedly, so the cooldown only applies outside NODE_ENV=test.
const COOLDOWN_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;

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

  // Scenario/seed pairs that have recorded model responses, so REPLAY can investigate them.
  router.get('/recorded', (_req, res) => {
    const file = join(DEFAULT_CASSETTE_DIR, 'manifest.json');
    res.json(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  });

  // The demo is public, so a reset or undo by one visitor affects everyone. A short cooldown and a
  // one-at-a-time lock stop button mashing; every reset first saves a snapshot that Undo restores.
  let busy = false;
  let lastChange = 0;
  const guard = async (work: () => Promise<void>): Promise<void> => {
    const wait = COOLDOWN_MS - (Date.now() - lastChange);
    if (busy || wait > 0) {
      throw new AppError('RATE_LIMITED', `Someone just reset or restored the demo. Try again in ${Math.max(1, Math.ceil(wait / 1000))} seconds.`);
    }
    busy = true;
    try {
      await work();
    } finally {
      lastChange = Date.now();
      busy = false;
    }
  };

  router.get('/reset-status', async (_req, res) => {
    res.json(await undoStatus(core));
  });

  router.post('/reset', async (_req, res) => {
    await guard(async () => {
      await snapshotDemoData(core);
      await resetDemoData(core);
    });
    res.json({ status: 'ok', ...(await undoStatus(core)) });
  });

  router.post('/undo-reset', async (_req, res) => {
    await guard(() => undoLastReset(core));
    res.json({ status: 'ok', ...(await undoStatus(core)) });
  });

  return router;
}
