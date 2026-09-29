import { Router } from 'express';
import type { PgBoss } from 'pg-boss';
import { pingDatabase, type Core, type Database, type ServerEnv } from '@payops/core';
import type { SessionConfig } from '../auth/session';
import { agentControlRoutes } from './agent-control';
import { approvalRoutes } from './approvals';
import { authRoutes } from './auth';
import { policyRoutes } from './policy';
import { auditRoutes } from './audit';
import { caseRoutes } from './cases';
import { overviewRoutes } from './overview';
import { paymentRoutes } from './payments';
import { runRoutes } from './runs';
import { simulatorRoutes } from './simulator';
import { webhookRoutes } from './webhooks';
import { handoffRoutes, savedViewRoutes } from './workflow';

export interface RouteDeps {
  database: Database;
  core: Core;
  boss: PgBoss;
}

interface RouterDeps extends RouteDeps {
  env: ServerEnv;
  session: SessionConfig;
}

export function buildRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = await pingDatabase(deps.database.pool);
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', checks: { database: db ? 'ok' : 'down' }, aiMode: deps.env.AI_MODE });
  });

  router.use('/auth', authRoutes(deps.core, deps.env, deps.session));
  router.use('/overview', overviewRoutes(deps.core));
  router.use('/payments', paymentRoutes(deps.core));
  router.use('/cases', caseRoutes(deps.core, deps.boss));
  router.use('/runs', runRoutes(deps.core));
  router.use('/simulator', simulatorRoutes(deps.core, deps.env));
  router.use('/audit', auditRoutes(deps.core));
  router.use('/approvals', approvalRoutes(deps.core));
  router.use('/policy', policyRoutes());
  router.use('/agent-control', agentControlRoutes(deps.core));
  router.use('/views', savedViewRoutes(deps.core));
  router.use('/handoff', handoffRoutes(deps.core));
  router.use('/webhooks', webhookRoutes(deps.core));

  return router;
}
