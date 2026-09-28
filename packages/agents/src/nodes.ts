/**
 * Graph nodes (docs/03-agent-system.md §5), scoped to Phase 3: one full investigator (no
 * specialist fan-out, no risk agent, no grounding check, no replan — those are Phase 4/5).
 * `execute` folds the doc's execute → validate → close into one call to
 * `resolutions.finish()`, which already runs that exact sequence for a person's proposal; the
 * agent takes the same code path, just with `onFailure: 'ESCALATE'` instead of reopening the
 * case for a person to retry (docs/06-phases.md Phase 3: "No replan yet (FAIL → escalate)").
 *
 * Simplifications kept, and recorded in docs/DECISIONS.md: `EvidenceItem.stepId` holds the
 * node name rather than a specific `agent_steps` row id; the agent's `AttemptHistory` is always
 * empty (a fresh run rarely follows a failed manual attempt in the seeded demo data).
 */
import { interrupt } from '@langchain/langgraph';
import { agentWriteContext, choice, loadCaseState, noul, type CaseState } from '@payops/core';
import {
  AGENT_BUDGET_LIMITS,
  zeroBudget,
  type AgentApprovalDecision,
  type Diagnosis,
  type EvidenceItem,
  type Finding,
  type RootCause,
  type RunStatus,
} from '@payops/shared';
import type { AgentDeps } from './deps';
import { buildCaseBrief } from './brief';
import { buildProposal } from './proposal';
import { diagnosisPrompt, findingsPrompt, followUpPrompt } from './prompts';
import { narrativeFor } from './templates';
import { DiagnosisSchema, FindingsSchema, FollowUpChoiceSchema } from './schemas';
import type { PayOpsStateType, PayOpsUpdate } from './state';
import { BASELINE_TOOLS, FOLLOWUP_TOOLS } from './tools';
import { nextEvidenceId, nextFindingId } from './run-ids';

const ROOT_CAUSE_CRITERIA: Record<RootCause, string> = {
  WEBHOOK_PROCESSING_FAILURE: 'A webhook for this payment was delivered but our consumer failed to process it (non-2xx response).',
  WEBHOOK_NOT_DELIVERED: 'A webhook for this payment was never delivered at all.',
  ORDER_STATE_DIVERGED: 'The gateway shows one state (e.g. captured) but our order record shows another.',
  LEDGER_POSTING_MISSING: 'The gateway captured the payment but no ledger credit was ever posted for it.',
  DUPLICATE_CAPTURE: 'More than one gateway capture exists for the same order.',
  REFUND_STATUS_NOT_SYNCED: 'The gateway refund status has moved on but our internal refund record still shows the old status.',
  REFUND_NOT_INITIATED: 'The order was cancelled or should be refunded, but no refund has been created yet.',
  REFUND_FAILED_AT_GATEWAY: 'A refund was attempted but the gateway reports it failed.',
  SETTLEMENT_FEE_MISMATCH: "The settlement batch's fees or net amount do not match what the ledger expects.",
  SETTLEMENT_LINE_MISSING: 'A settlement line the ledger expects for this batch is missing.',
  SUSPECTED_FRAUD: 'The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.',
  UNKNOWN: 'None of the above clearly explains this case from the facts given.',
};

function evidenceFrom(existing: readonly EvidenceItem[], caseState: CaseState, tools: typeof BASELINE_TOOLS, stepId: string): EvidenceItem[] {
  const created: EvidenceItem[] = [];
  let pool = [...existing];
  for (const tool of tools) {
    for (const draft of tool.run(caseState)) {
      const id = nextEvidenceId(pool);
      const item: EvidenceItem = { id, stepId, ...draft };
      created.push(item);
      pool = [...pool, item];
    }
  }
  return created;
}

export function buildNodes(deps: AgentDeps) {
  const { core, llm, decision, onEvent } = deps;

  async function loadCase(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('loadCase', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    await onEvent('loadCase', 'NODE_COMPLETED', { entityRefs: caseState.case.entityRefs });
    return { entityRefs: caseState.case.entityRefs, status: 'INVESTIGATING' };
  }

  async function triage(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('triage', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = buildCaseBrief(caseState);
    const evidence = evidenceFrom(state.evidence, caseState, BASELINE_TOOLS, 'triage');
    await onEvent('triage', 'TOOL_COMPLETED', { tools: BASELINE_TOOLS.map((t) => t.name), evidenceIds: evidence.map((e) => e.id) });
    await onEvent('triage', 'NODE_COMPLETED', { brief });
    return { case: brief, evidence, budget: { ...zeroBudget(), toolCalls: evidence.length } };
  }

  async function diagnose(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('diagnose', 'NODE_STARTED', {});
    const brief = state.case!;
    try {
      const result = await decision.ask({
        tag: 'J6_DIAGNOSE',
        state: {
          caseType: brief.type,
          detectionRuleIds: brief.detectionRuleIds,
          amountBand: brief.amountBand,
          mismatchedSystems: brief.mismatchedSystems,
          flags: brief.flags,
        },
        questions: {
          root_cause: choice('What is most likely causing this case?', ROOT_CAUSE_CRITERIA),
          evidence_consistent: noul('The facts point to one clear cause.'),
          needs_human: noul('This case looks unusual or risky and should get a full investigation.'),
        },
      });
      await onEvent('diagnose', 'DECISION_MADE', { tag: 'J6_DIAGNOSE', answers: result.answers, usage: result.usage });
      const confidence = result.answers.root_cause.confidence;
      const needsHuman = result.answers.needs_human.noul;
      const fast = confidence >= 0.8 && needsHuman <= 0.5;
      const diagnosis: Diagnosis | null = fast
        ? { rootCause: result.answers.root_cause.choice, narrative: '', confidence, supportingFindingIds: [], path: 'FAST' }
        : null;
      await onEvent('diagnose', 'NODE_COMPLETED', { path: fast ? 'FAST' : 'FULL', rootCause: result.answers.root_cause.choice, confidence });
      return {
        diagnosis,
        budget: { ...zeroBudget(), jevCalls: 1, tokensIn: result.usage.input_tokens, tokensOut: result.usage.output_tokens },
      };
    } catch (err) {
      await onEvent('diagnose', 'NODE_COMPLETED', { path: 'FULL', fallback: true, error: err instanceof Error ? err.message : String(err) });
      return { diagnosis: null };
    }
  }

  async function investigate(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('investigate', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = state.case!;

    const choiceResult = await llm.invokeStructured(FollowUpChoiceSchema, followUpPrompt(brief, state.evidence), {
      node: 'investigate',
      callIndex: 0,
      scenarioKey: state.scenarioKey,
    });
    const wanted = choiceResult.data.followUps.slice(0, AGENT_BUDGET_LIMITS.maxFollowupToolCalls);
    await onEvent('investigate', 'LLM_CALLED', { call: 'followUps', followUps: wanted, usage: choiceResult.usage });

    const followUpTools = FOLLOWUP_TOOLS.filter((t) => wanted.some((w) => w.tool === t.name));
    const followUpEvidence = evidenceFrom(state.evidence, caseState, followUpTools, 'investigate');
    if (followUpEvidence.length > 0) {
      await onEvent('investigate', 'TOOL_COMPLETED', { tools: followUpTools.map((t) => t.name), evidenceIds: followUpEvidence.map((e) => e.id) });
    }
    const allEvidence = [...state.evidence, ...followUpEvidence];

    const findingsResult = await llm.invokeStructured(FindingsSchema, findingsPrompt(brief, allEvidence), {
      node: 'investigate',
      callIndex: 1,
      scenarioKey: state.scenarioKey,
    });
    const validIds = new Set(allEvidence.map((e) => e.id));
    let pool = state.findings;
    const findings: Finding[] = [];
    for (const f of findingsResult.data.findings) {
      const evidenceIds = f.evidenceIds.filter((id) => validIds.has(id));
      if (evidenceIds.length === 0) continue; // structural grounding: a finding must cite real evidence
      const id = nextFindingId(pool);
      const finding: Finding = { id, agent: 'payment', code: f.code, statement: f.statement, evidenceIds, confidence: f.confidence };
      findings.push(finding);
      pool = [...pool, finding];
    }
    await onEvent('investigate', 'FINDING_CREATED', { findingIds: findings.map((f) => f.id) });
    await onEvent('investigate', 'NODE_COMPLETED', { evidenceCount: allEvidence.length, findingCount: findings.length });

    return {
      evidence: followUpEvidence,
      findings,
      budget: {
        ...zeroBudget(),
        llmCalls: 2,
        toolCalls: followUpEvidence.length,
        tokensIn: choiceResult.usage.inputTokens + findingsResult.usage.inputTokens,
        tokensOut: choiceResult.usage.outputTokens + findingsResult.usage.outputTokens,
      },
    };
  }

  async function resolve(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('resolve', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = state.case!;

    let diagnosis = state.diagnosis;
    let budget = zeroBudget();
    if (!diagnosis) {
      const result = await llm.invokeStructured(DiagnosisSchema, diagnosisPrompt(brief, state.findings, state.evidence, state.history), {
        node: 'resolve',
        callIndex: 0,
        scenarioKey: state.scenarioKey,
      });
      diagnosis = { ...result.data, path: 'FULL' };
      budget = { ...zeroBudget(), llmCalls: 1, tokensIn: result.usage.inputTokens, tokensOut: result.usage.outputTokens };
      await onEvent('resolve', 'LLM_CALLED', { call: 'diagnosis', diagnosis, usage: result.usage });
    } else if (!diagnosis.narrative) {
      // Fast path: code narrative template, no LLM (docs/03 §4a).
      const narrative = narrativeFor(diagnosis.rootCause, state.evidence);
      diagnosis = { ...diagnosis, narrative: narrative.text, supportingFindingIds: narrative.citedIds };
    }

    const proposal = buildProposal(diagnosis, caseState, []);
    await onEvent('resolve', 'PROPOSAL_CREATED', { diagnosis, proposal });
    await onEvent('resolve', 'NODE_COMPLETED', {});
    return { diagnosis, proposal, budget };
  }

  async function policyGate(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('policyGate', 'NODE_STARTED', {});
    const proposal = state.proposal!;
    const diagnosis = state.diagnosis!;
    const { resolution, approvalId } = await core.resolutions.proposeFromAgent(
      state.caseId,
      state.runId,
      { actions: proposal.actions, rationale: proposal.rationale },
      { diagnosisConfidence: diagnosis.confidence, groundingViolations: 0 },
    );
    await onEvent('policyGate', 'POLICY_DECIDED', { tier: resolution.policy.tier, reasons: resolution.policy.reasons, resolutionId: resolution.id });
    let status: RunStatus = 'EXECUTING';
    if (resolution.policy.tier === 'BLOCKED') status = 'ESCALATED';
    else if (resolution.policy.tier === 'OPS' || resolution.policy.tier === 'MANAGER') status = 'AWAITING_APPROVAL';
    if (approvalId) await onEvent('policyGate', 'APPROVAL_REQUESTED', { approvalId, tier: resolution.policy.tier });
    await onEvent('policyGate', 'NODE_COMPLETED', { tier: resolution.policy.tier });
    return { policy: resolution.policy, resolutionId: resolution.id, approvalId, attempt: resolution.attempt, status };
  }

  async function awaitApproval(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('awaitApproval', 'NODE_STARTED', { approvalId: state.approvalId });
    const decided = interrupt({ approvalId: state.approvalId, tier: state.policy?.tier, proposal: state.proposal }) as AgentApprovalDecision;
    await onEvent('awaitApproval', 'APPROVAL_RESOLVED', { decision: decided.decision });
    const status: RunStatus = decided.decision === 'APPROVE' ? 'EXECUTING' : decided.decision === 'REJECT' ? 'REJECTED' : 'ESCALATED';
    return { approval: decided, status };
  }

  async function execute(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('execute', 'NODE_STARTED', { resolutionId: state.resolutionId });
    const write = agentWriteContext(state.caseId, state.runId);
    const item = await core.resolutions.finish(state.resolutionId!, write, { onFailure: 'ESCALATE' });
    await onEvent('execute', 'EXECUTION_STEP', { executions: item.executions });
    await onEvent('execute', 'VALIDATION_COMPLETED', { validation: item.validation });
    const escalates = (state.proposal?.actions ?? []).some((a) => a.type === 'ESCALATE_TO_HUMAN');
    let status: RunStatus;
    if (item.status === 'EXECUTION_FAILED') status = 'ESCALATED';
    else if (item.validation?.verdict === 'PASS') status = escalates ? 'ESCALATED' : 'RESOLVED';
    else status = 'ESCALATED';
    await onEvent('execute', 'RUN_COMPLETED', { status });
    return {
      executions: item.executions,
      validation: item.validation ? { verdict: item.validation.verdict, checks: item.validation.checks } : null,
      status,
    };
  }

  async function closeBlocked(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED', reason: 'BLOCKED by policy' });
    return { status: 'ESCALATED' };
  }

  async function closeRejected(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'REJECTED' });
    return { status: 'REJECTED' };
  }

  async function closeEscalated(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED' });
    return { status: 'ESCALATED' };
  }

  return { loadCase, triage, diagnose, investigate, resolve, policyGate, awaitApproval, execute, closeBlocked, closeRejected, closeEscalated };
}
