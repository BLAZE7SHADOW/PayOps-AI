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
import {
  AGENT_NAMES,
  AGENT_STEP_KINDS,
  CatalogAction,
  EVIDENCE_SYSTEMS,
  FINDING_CODES,
  POLICY_RULE_IDS,
  POLICY_TIERS,
  RISK_TIERS,
  ROOT_CAUSES,
  RUN_PATHS,
  RUN_STATUS,
} from '@payops/shared';
import { parseBody } from '../lib/validate';

const id = z.string().min(1).max(64);
const verdict = z.enum(['PASS', 'PARTIAL', 'FAIL']);

// The Python service builds these from the same vocabulary, so a value outside it is a bug on one side and is refused here.
const Diagnosis = z.object({
  rootCause: z.enum(ROOT_CAUSES),
  narrative: z.string(),
  confidence: z.number().min(0).max(1),
  supportingFindingIds: z.array(z.string()),
  path: z.enum(RUN_PATHS),
});
const ProposalDraft = z.object({ actions: z.array(CatalogAction).min(1), rationale: z.string() });
const Proposal = ProposalDraft.extend({ expectedPostconditions: z.array(z.string()) });
const AttemptSummary = z.object({
  attempt: z.number().int(),
  actions: z.array(CatalogAction),
  failedChecks: z.array(z.string()),
  validatorNotes: z.string(),
  verdict,
});
const Evidence = z.object({
  id: z.string(),
  source: z.string(),
  system: z.enum(EVIDENCE_SYSTEMS),
  entityRef: z.string(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  observedAt: z.string(),
  stepId: z.string(),
});
const Finding = z.object({
  id: z.string(),
  agent: z.enum(AGENT_NAMES),
  code: z.enum(FINDING_CODES),
  statement: z.string(),
  evidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
const Policy = z.object({
  tier: z.enum(POLICY_TIERS),
  reasons: z.array(z.object({ ruleId: z.enum(POLICY_RULE_IDS), tier: z.enum(POLICY_TIERS), reason: z.string() })),
  version: z.string(),
  moneyMovingMinor: z.number(),
  riskTier: z.enum(RISK_TIERS),
});
const Grounding = z.object({
  checked: z.number().int(),
  violations: z.array(z.object({ findingId: z.string(), reason: z.string() })),
  sufficient: z.boolean(),
  needsHumanReview: z.boolean().optional(),
});
const Budget = z.object({
  llmCalls: z.number(),
  jevCalls: z.number(),
  toolCalls: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number(),
});
// The parts of a run's state that are copied onto its row (the keys `syncRunRow` reads).
const SyncedState = z.object({
  status: z.enum(RUN_STATUS),
  diagnosis: Diagnosis.nullable(),
  resolutionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  attempt: z.number().int(),
  budget: Budget,
  evidence: z.array(Evidence),
  findings: z.array(Finding),
  proposal: Proposal.nullable(),
  policy: Policy.nullable(),
  grounding: Grounding.nullable(),
}).partial();

const CaseOnly = z.object({ caseId: id });
const Tools = z.object({ caseId: id, tools: z.array(z.string().min(1).max(64)).max(40) });
const ProposalRequest = z.object({ caseId: id, diagnosis: Diagnosis, history: z.array(AttemptSummary).max(10) });
const PolicyGate = z.object({ caseId: id, runId: id, proposal: ProposalDraft, diagnosisConfidence: z.number().min(0).max(1) });
const Execute = z.object({ caseId: id, runId: id, resolutionId: id });
const Validate = z.object({ resolutionId: id });
const CloseValidated = z.object({ caseId: id, runId: id, resolutionId: id, verdict });
const Escalate = z.object({ caseId: id, runId: id, reason: z.string().min(1).max(500) });
const Step = z.object({ runId: id, caseId: id, node: z.string().min(1).max(64), kind: z.enum(AGENT_STEP_KINDS), payload: z.record(z.string(), z.unknown()) });
const Sync = z.object({ runId: id, caseId: id, state: SyncedState, interrupted: z.boolean() });
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
    const body = parseBody(ProposalRequest, req);
    res.json(await remoteProposal(core, body.caseId, body.diagnosis, body.history));
  });

  router.post('/policy-gate', async (req, res) => {
    const body = parseBody(PolicyGate, req);
    res.json(await remotePolicyGate(core, body));
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
    await remoteSyncRun(core, body);
    res.json({ ok: true });
  });

  router.post('/fail', async (req, res) => {
    const body = parseBody(Fail, req);
    await remoteFailRun(core, body.runId, body.error);
    res.json({ ok: true });
  });

  return router;
}
