/**
 * The API the Python agent service calls (D085). Not part of `/api`: it has no session or role, only
 * a shared secret, and Vercel never forwards it. Every route is a thin wrapper over a function in
 * `@payops/agents`' `remote.ts`, so the Python graph reaches data and authority only through the
 * same code the TypeScript graph uses (tools, policy gate, executor, validator, step store).
 */
import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  remoteCaseBrief,
  remoteCloseValidated,
  remoteEscalateWithoutProposal,
  remoteExecute,
  remoteFailRun,
  remotePolicyGate,
  remoteProposal,
  remoteRecordStep,
  remoteRunTools,
  remoteSyncRun,
  remoteValidate,
} from '@payops/agents';
import { AppError, type Core } from '@payops/core';
import { AGENT_STEP_KINDS } from '@payops/shared';
import { parseBody } from '../lib/validate';

const id = z.string().min(1).max(64);
// Nested shapes (diagnosis, proposal, state) are produced by our own Python code from our own
// schemas and go straight to typed functions; they are not re-described here.
const loose = z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null);

const CaseOnly = z.object({ caseId: id });
const Tools = z.object({ caseId: id, tools: z.array(z.string().min(1).max(64)).max(40) });
const Proposal = z.object({ caseId: id, diagnosis: loose, history: z.array(loose).max(10) });
const PolicyGate = z.object({ caseId: id, runId: id, proposal: loose, diagnosisConfidence: z.number().min(0).max(1) });
const Execute = z.object({ caseId: id, runId: id, resolutionId: id });
const Validate = z.object({ resolutionId: id });
const CloseValidated = z.object({ caseId: id, runId: id, resolutionId: id, verdict: z.enum(['PASS', 'PARTIAL', 'FAIL']) });
const Escalate = z.object({ caseId: id, runId: id, reason: z.string().min(1).max(500) });
const Step = z.object({ runId: id, caseId: id, node: z.string().min(1).max(64), kind: z.enum(AGENT_STEP_KINDS), payload: loose });
const Sync = z.object({ runId: id, caseId: id, state: loose, interrupted: z.boolean() });
const Fail = z.object({ runId: id, error: z.string().max(2000) });

function requireSecret(secret: string): RequestHandler {
  const expected = Buffer.from(secret);
  return (req, _res, next) => {
    const given = Buffer.from(String(req.header('x-agent-secret') ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return next(new AppError('UNAUTHENTICATED', 'Invalid agent service secret'));
    }
    next();
  };
}

export function internalAgentRoutes(core: Core, secret: string): Router {
  const router = Router();
  router.use(requireSecret(secret));

  router.post('/case-brief', async (req, res) => {
    const { caseId } = parseBody(CaseOnly, req);
    res.json(await remoteCaseBrief(core, caseId));
  });

  router.post('/tools', async (req, res) => {
    const { caseId, tools } = parseBody(Tools, req);
    res.json({ results: await remoteRunTools(core, caseId, tools) });
  });

  router.post('/proposal', async (req, res) => {
    const body = parseBody(Proposal, req);
    res.json(await remoteProposal(core, body.caseId, body.diagnosis as never, body.history as never));
  });

  router.post('/policy-gate', async (req, res) => {
    const body = parseBody(PolicyGate, req);
    res.json(await remotePolicyGate(core, { ...body, proposal: body.proposal as never }));
  });

  router.post('/execute', async (req, res) => {
    res.json(await remoteExecute(core, parseBody(Execute, req)));
  });

  router.post('/validate', async (req, res) => {
    res.json(await remoteValidate(core, parseBody(Validate, req).resolutionId));
  });

  router.post('/close-validated', async (req, res) => {
    await remoteCloseValidated(core, parseBody(CloseValidated, req));
    res.json({ ok: true });
  });

  router.post('/escalate-without-proposal', async (req, res) => {
    await remoteEscalateWithoutProposal(core, parseBody(Escalate, req));
    res.json({ ok: true });
  });

  router.post('/steps', async (req, res) => {
    await remoteRecordStep(core, parseBody(Step, req));
    res.json({ ok: true });
  });

  router.post('/sync', async (req, res) => {
    const body = parseBody(Sync, req);
    await remoteSyncRun(core, { ...body, state: body.state as never });
    res.json({ ok: true });
  });

  router.post('/fail', async (req, res) => {
    const body = parseBody(Fail, req);
    await remoteFailRun(core, body.runId, body.error);
    res.json({ ok: true });
  });

  return router;
}
