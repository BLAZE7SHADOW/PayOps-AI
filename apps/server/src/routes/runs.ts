/**
 * Agent run endpoints (docs/02-architecture.md §5): starting an investigation, and reading its
 * state back — including `/steps`, which is what a reconnecting client rebuilds its timeline
 * from (docs/03-agent-system.md §16).
 */
import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { tables, type Core } from '@payops/core';
import { RunListQuery, type AgentRunItem, type AgentStepItem, type Page } from '@payops/shared';
import { requireRole } from '../auth/middleware';
import { param, parseQuery } from '../lib/validate';

const { agentRuns, agentSteps } = tables;

async function toRunItem(core: Core, row: typeof agentRuns.$inferSelect): Promise<AgentRunItem> {
  let executions: AgentRunItem['executions'] = [];
  let validation: AgentRunItem['validation'] = null;
  let policy = row.policy;
  if (row.resolutionId) {
    try {
      const item = await core.resolutionQueries.item(row.resolutionId);
      executions = item.executions;
      validation = item.validation ? { verdict: item.validation.verdict, checks: item.validation.checks } : null;
      policy = item.policy;
    } catch {
      // resolution not found (shouldn't happen once resolutionId is set) — fall back to the run's own snapshot.
    }
  }
  return {
    id: row.id,
    caseId: row.caseId,
    resolutionId: row.resolutionId,
    status: row.status,
    path: row.path,
    attempt: row.attempt,
    budget: row.budget,
    diagnosis: row.diagnosis,
    proposal: row.proposal,
    policy,
    approvalId: row.approvalId,
    executions,
    validation,
    findings: row.findings,
    evidence: row.evidence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

function toStepItem(row: typeof agentSteps.$inferSelect): AgentStepItem {
  return { id: row.id, runId: row.runId, seq: row.seq, node: row.node, kind: row.kind, payload: row.payload, at: row.at.toISOString() };
}

export function runRoutes(core: Core): Router {
  const router = Router();

  router.get('/', requireRole('VIEWER'), async (req, res) => {
    const query = parseQuery(RunListQuery, req);
    const conditions = [query.caseId ? eq(agentRuns.caseId, query.caseId) : undefined, query.status ? eq(agentRuns.status, query.status) : undefined].filter(
      (c): c is NonNullable<typeof c> => c != null,
    );
    const rows = await core.db
      .select()
      .from(agentRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(agentRuns.createdAt))
      .limit(query.limit);
    const items = await Promise.all(rows.map((r) => toRunItem(core, r)));
    const body: Page<AgentRunItem> = { items, nextCursor: null, total: items.length };
    res.json(body);
  });

  router.get('/:id', requireRole('VIEWER'), async (req, res) => {
    const [row] = await core.db.select().from(agentRuns).where(eq(agentRuns.id, param(req, 'id'))).limit(1);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    res.json(await toRunItem(core, row));
  });

  router.get('/:id/steps', requireRole('VIEWER'), async (req, res) => {
    const rows = await core.db.select().from(agentSteps).where(eq(agentSteps.runId, param(req, 'id'))).orderBy(agentSteps.seq);
    const body: Page<AgentStepItem> = { items: rows.map(toStepItem), nextCursor: null, total: rows.length };
    res.json(body);
  });

  return router;
}
