import { Router } from 'express';
import type { PgBoss } from 'pg-boss';
import { createAgentRun } from '@payops/agents';
import {
  CaseListQuery,
  CreateRunBody,
  PreviewActionsBody,
  ProposeActionsBody,
  type CaseDetail,
  type CaseSourceRecords,
  type CaseListItem,
  type Page,
  type PolicyPreview,
  type ResolutionItem,
} from '@payops/shared';
import { loadCaseState, projectCaseSourceRecords, type Core } from '@payops/core';
import type { AgentRunJobPayload } from '../jobs/agents';
import { QUEUES } from '../jobs/boss';
import { requireRole, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

export function caseRoutes(core: Core, boss: PgBoss): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const body: Page<CaseListItem> = await core.cases.list(parseQuery(CaseListQuery, req));
    res.json(body);
  });

  router.get('/:id', requireRole('VIEWER'), async (req, res) => {
    const body: CaseDetail = await core.cases.get(param(req, 'id'), sessionUser(req));
    res.json(body);
  });

  router.get('/:id/records', requireRole('VIEWER'), async (req, res) => {
    const state = await loadCaseState(core.db, core.gateway, param(req, 'id'), core.clock.now());
    const body: CaseSourceRecords = projectCaseSourceRecords(state);
    res.json(body);
  });

  router.post('/:id/actions/preview', requireRole('OPS'), async (req, res) => {
    const { actions } = parseBody(PreviewActionsBody, req);
    const body: PolicyPreview = await core.resolutions.preview(param(req, 'id'), actions, sessionUser(req));
    res.json(body);
  });

  router.post('/:id/actions', requireRole('OPS'), async (req, res) => {
    const body: ResolutionItem = await core.resolutions.propose(param(req, 'id'), parseBody(ProposeActionsBody, req), sessionUser(req));
    res.status(201).json(body);
  });

  /** Starts an agent investigation (docs/02-architecture.md §4.2). Job does the actual work. */
  router.post('/:id/runs', requireRole('OPS'), async (req, res) => {
    const caseId = param(req, 'id');
    const body = CreateRunBody.parse(req.body);
    const { runId } = await createAgentRun(core, caseId, body.scenarioKey);
    const payload: AgentRunJobPayload = { runId, caseId, scenarioKey: body.scenarioKey };
    await boss.send(QUEUES.agentRun, payload);
    res.status(202).json({ runId });
  });

  return router;
}
