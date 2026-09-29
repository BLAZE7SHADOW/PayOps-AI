import { Router } from 'express';
import type { PgBoss } from 'pg-boss';
import { createAgentRun } from '@payops/agents';
import {
  AssignCaseBody,
  CaseListQuery,
  CreateRunBody,
  OperatorNoteBody,
  type OperatorNoteItem,
  PreviewActionsBody,
  ProposeActionsBody,
  type CaseDetail,
  type CaseSourceRecords,
  type CaseListItem,
  type Page,
  type PolicyPreview,
  type ResolutionItem,
} from '@payops/shared';
import { loadCaseState, notFound, projectCaseSourceRecords, type Core } from '@payops/core';
import type { AgentRunJobPayload } from '../jobs/agents';
import { QUEUES } from '../jobs/boss';
import { requirePermission, sessionUser } from '../auth/middleware';
import { param, parseBody, parseQuery } from '../lib/validate';

export function caseRoutes(core: Core, boss: PgBoss): Router {
  const router = Router();

  router.get('/', requirePermission('case.view'), async (req, res) => {
    const body: Page<CaseListItem> = await core.cases.list(parseQuery(CaseListQuery, req));
    res.json(body);
  });

  router.get('/:id', requirePermission('case.view'), async (req, res) => {
    const body: CaseDetail = await core.cases.get(param(req, 'id'), sessionUser(req));
    res.json(body);
  });

  router.put('/:id/assignee', requirePermission('case.assign'), async (req, res) => {
    const { assigneeId } = parseBody(AssignCaseBody, req);
    const body: CaseListItem = await core.cases.assign(param(req, 'id'), assigneeId, sessionUser(req));
    res.json(body);
  });

  /** Operator notes (P2 task 2, D068). Newest first. */
  router.get('/:id/notes', requirePermission('case.view'), async (req, res) => {
    const items = await core.caseNotes.list(param(req, 'id'));
    const body: Page<OperatorNoteItem> = { items, nextCursor: null, total: items.length };
    res.json(body);
  });

  router.post('/:id/notes', requirePermission('case.note'), async (req, res) => {
    const body: OperatorNoteItem = await core.caseNotes.add(param(req, 'id'), parseBody(OperatorNoteBody, req), sessionUser(req));
    res.status(201).json(body);
  });

  router.get('/:id/records', requirePermission('case.view'), async (req, res) => {
    const state = await loadCaseState(core.db, core.gateway, param(req, 'id'), core.clock.now());
    const body: CaseSourceRecords = projectCaseSourceRecords(state);
    res.json(body);
  });

  router.post('/:id/actions/preview', requirePermission('resolution.propose'), async (req, res) => {
    const { actions } = parseBody(PreviewActionsBody, req);
    const body: PolicyPreview = await core.resolutions.preview(param(req, 'id'), actions, sessionUser(req));
    res.json(body);
  });

  router.post('/:id/actions', requirePermission('resolution.propose'), async (req, res) => {
    const body: ResolutionItem = await core.resolutions.propose(param(req, 'id'), parseBody(ProposeActionsBody, req), sessionUser(req));
    res.status(201).json(body);
  });

  /** Undo a passed resolution that posted to the ledger. Goes through the normal proposal flow (D070). */
  router.post('/:id/resolutions/:resolutionId/undo', requirePermission('resolution.undo'), async (req, res) => {
    const resolutionId = param(req, 'resolutionId');
    const item = await core.resolutionQueries.item(resolutionId);
    if (item.caseId !== param(req, 'id')) throw notFound('Resolution', resolutionId);
    const body: ResolutionItem = await core.resolutions.undo(resolutionId, sessionUser(req));
    res.status(201).json(body);
  });

  /** Starts an agent investigation (docs/02-architecture.md §4.2). Job does the actual work. */
  router.post('/:id/runs', requirePermission('run.start'), async (req, res) => {
    const caseId = param(req, 'id');
    const body = CreateRunBody.parse(req.body);
    const { runId } = await createAgentRun(core, caseId, body.scenarioKey);
    const payload: AgentRunJobPayload = { runId, caseId, scenarioKey: body.scenarioKey };
    await boss.send(QUEUES.agentRun, payload);
    res.status(202).json({ runId });
  });

  return router;
}
