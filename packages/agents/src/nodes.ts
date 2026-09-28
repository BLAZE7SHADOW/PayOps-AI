/**
 * Graph nodes (docs/03-agent-system.md §5). Phase 3's single `investigate` node is split
 * (Phase 4 task 3) into a `plan` node (J2) that routes to Payment/Reconciliation/Risk
 * specialists via LangGraph `Send`, which converge on `join` before `resolve` — grounding
 * (`groundCheck`) and replan are still later Phase 4/5 tasks, so `join` feeds `resolve` directly.
 * `execute` folds the doc's execute → validate → close into one call to
 * `resolutions.finish()`, which already runs that exact sequence for a person's proposal; the
 * agent takes the same code path, just with `onFailure: 'ESCALATE'` instead of reopening the
 * case for a person to retry (docs/06-phases.md Phase 3: "No replan yet (FAIL → escalate)").
 *
 * Simplifications kept, and recorded in docs/DECISIONS.md: `EvidenceItem.stepId` holds the
 * node name rather than a specific `agent_steps` row id; the agent's `AttemptHistory` is always
 * empty (a fresh run rarely follows a failed manual attempt in the seeded demo data); `triage`
 * still gathers the combined baseline evidence for every group up front (D038), so the fast path
 * (`diagnose` → `resolve`, which never runs `plan` or the specialists) still has evidence to cite.
 */
import { interrupt } from '@langchain/langgraph';
import { agentWriteContext, choice, loadCaseState, noul, type CaseState } from '@payops/core';
import {
  AGENT_BUDGET_LIMITS,
  AGENT_NAMES,
  zeroBudget,
  type AgentApprovalDecision,
  type AgentName,
  type Diagnosis,
  type EvidenceItem,
  type Finding,
  type InvestigationPlan,
  type RootCause,
  type RunStatus,
} from '@payops/shared';
import type { AgentDeps } from './deps';
import { buildCaseBrief } from './brief';
import { choosePlanSpecialists } from './planning';
import { buildProposal } from './proposal';
import { diagnosisPrompt, findingsPrompt, followUpPrompt } from './prompts';
import { narrativeFor } from './templates';
import { DiagnosisSchema, FindingsSchema, buildFollowUpChoiceSchema } from './schemas';
import type { PayOpsStateType, PayOpsUpdate } from './state';
import {
  BASELINE_TOOLS,
  PAYMENT_FOLLOWUP_TOOLS,
  PAYMENT_TOOLS,
  RECONCILIATION_FOLLOWUP_TOOLS,
  RECONCILIATION_TOOLS,
  RISK_FOLLOWUP_TOOLS,
  RISK_TOOLS,
  type ToolDef,
} from './tools';
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

/** J2's `primary_hypothesis` Choice (docs/03 §4 "J2"): a coarser five-way split than
 * `RootCause`, just enough to decide which specialists are worth running. */
const PRIMARY_HYPOTHESIS_CRITERIA: Record<string, string> = {
  webhook_or_state_sync: 'A webhook was missed, failed or arrived late, so our order/payment state diverged from the gateway.',
  duplicate_capture: 'More than one gateway capture exists for the same order.',
  refund_lifecycle: 'A refund is missing, not yet initiated, stuck out of sync, or failed at the gateway.',
  settlement_reconciliation: "A settlement batch's fees or net amount do not match what the ledger expects.",
  fraud_or_abuse: 'The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.',
};

function evidenceFrom(existing: readonly EvidenceItem[], caseState: CaseState, tools: readonly ToolDef[], stepId: string): EvidenceItem[] {
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
    return { case: brief, evidence, budget: { ...zeroBudget(), toolCalls: BASELINE_TOOLS.length } };
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
      const fast = confidence >= 0.8 && needsHuman <= 0.5 && result.answers.evidence_consistent.noul > 0.5
        && narrativeFor(result.answers.root_cause.choice, state.evidence).citedIds.length > 0;
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
      return { diagnosis: null, budget: { ...zeroBudget(), jevCalls: 1 } };
    }
  }

  /** J2 (docs/03 §4 "J2"): decide which specialists the full path needs. Only reached when
   * `diagnose` did not resolve fast (see the header note on why `triage` still gathers
   * combined baseline evidence up front). */
  async function plan(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('plan', 'NODE_STARTED', {});
    const brief = state.case!;
    try {
      const result = await decision.ask({
        tag: 'J2_PLAN',
        state: {
          caseType: brief.type,
          detectionRuleIds: brief.detectionRuleIds,
          amountBand: brief.amountBand,
          mismatchedSystems: brief.mismatchedSystems,
          flags: brief.flags,
        },
        questions: {
          primary_hypothesis: choice('What most likely explains why the systems disagree on this case?', PRIMARY_HYPOTHESIS_CRITERIA),
          need_payment: noul('Investigating the payment/gateway/webhook trail would materially help diagnose this case.'),
          need_reconciliation: noul('Investigating the ledger/settlement trail would materially help diagnose this case.'),
          need_risk: noul('Investigating fraud and risk signals would materially help diagnose this case.'),
        },
      });
      await onEvent('plan', 'DECISION_MADE', { tag: 'J2_PLAN', answers: result.answers, usage: result.usage });
      const confidence = result.answers.primary_hypothesis.confidence;
      const specialists = choosePlanSpecialists({
        amountBand: brief.amountBand,
        primaryConfidence: confidence,
        needScores: {
          payment: result.answers.need_payment.noul,
          reconciliation: result.answers.need_reconciliation.noul,
          risk: result.answers.need_risk.noul,
        },
      });
      const investigationPlan: InvestigationPlan = {
        primaryHypothesis: result.answers.primary_hypothesis.choice,
        specialists,
        routedBy: 'JEV',
        confidence,
      };
      await onEvent('plan', 'NODE_COMPLETED', { specialists, routedBy: 'JEV', primaryHypothesis: investigationPlan.primaryHypothesis });
      return {
        plan: investigationPlan,
        investigationRound: state.investigationRound + 1,
        budget: { ...zeroBudget(), jevCalls: 1, tokensIn: result.usage.input_tokens, tokensOut: result.usage.output_tokens },
      };
    } catch (err) {
      // J2 fallback (docs/03 §4 "Jev adapter contract"): on error/timeout, run every specialist
      // rather than guess — the safe default the doc calls for.
      const investigationPlan: InvestigationPlan = { primaryHypothesis: 'UNKNOWN', specialists: [...AGENT_NAMES], routedBy: 'DEFAULT_ALL', confidence: 0 };
      await onEvent('plan', 'NODE_COMPLETED', {
        specialists: investigationPlan.specialists,
        routedBy: 'DEFAULT_ALL',
        fallback: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return { plan: investigationPlan, investigationRound: state.investigationRound + 1, budget: { ...zeroBudget(), jevCalls: 1 } };
    }
  }

  /** Restricts evidence to the facts a specific tool group produced, so a specialist's own
   * prompt (and therefore anything it can cite) never contains another agent's evidence
   * (docs/03 §3/§8 "never contains"). A preview of Phase 4 task 4's real ContextBuilder. */
  function evidenceForTools(evidence: readonly EvidenceItem[], tools: readonly ToolDef[]): EvidenceItem[] {
    const names = new Set(tools.map((t) => t.name));
    return evidence.filter((e) => names.has(e.source));
  }

  /**
   * Builds one specialist node (`paymentAgent` / `reconciliationAgent` / `riskAgent`), each
   * running the same two-stage pattern Phase 3's `investigate` used (docs/03 §2), but scoped to
   * its own tool group: baseline evidence for this group already exists from `triage`, so the
   * specialist only runs its own follow-up pass (bounded LLM call #1, up to
   * `AGENT_BUDGET_LIMITS.maxFollowupToolCalls` tools from its own group) then emits findings
   * (LLM call #2) tagged with its own `AgentName`. When the group has no follow-up tools at all
   * (Risk, until Phase 4 task 5 adds risk tools) or no evidence to reason over, both LLM calls
   * are skipped and the specialist legitimately contributes zero evidence and zero findings.
   */
  function buildSpecialistNode(agentName: AgentName, nodeName: string, ownTools: readonly ToolDef[], followUpTools: readonly ToolDef[]) {
    const followUpSchema = buildFollowUpChoiceSchema(followUpTools);
    return async function specialistNode(state: PayOpsStateType): Promise<PayOpsUpdate> {
      await onEvent(nodeName, 'NODE_STARTED', {});
      const ownBaseline = evidenceForTools(state.evidence, ownTools);

      if (!followUpSchema || ownBaseline.length === 0) {
        await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownBaseline.length, findingCount: 0, skipped: true });
        return { agentsVisited: [agentName] };
      }

      const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
      const brief = state.case!;

      const choiceResult = await llm.invokeStructured(followUpSchema, followUpPrompt(brief, ownBaseline, followUpTools), {
        node: nodeName,
        callIndex: 0,
        scenarioKey: state.scenarioKey,
      });
      const wanted = choiceResult.data.followUps.slice(0, AGENT_BUDGET_LIMITS.maxFollowupToolCalls);
      await onEvent(nodeName, 'LLM_CALLED', { call: 'followUps', followUps: wanted, usage: choiceResult.usage });

      const chosenTools = followUpTools.filter((t) => wanted.some((w) => w.tool === t.name));
      const followUpEvidence = evidenceFrom(state.evidence, caseState, chosenTools, nodeName);
      if (followUpEvidence.length > 0) {
        await onEvent(nodeName, 'TOOL_COMPLETED', { tools: chosenTools.map((t) => t.name), evidenceIds: followUpEvidence.map((e) => e.id) });
      }
      const ownEvidence = [...ownBaseline, ...followUpEvidence];

      const findingsResult = await llm.invokeStructured(FindingsSchema, findingsPrompt(brief, ownEvidence), {
        node: nodeName,
        callIndex: 1,
        scenarioKey: state.scenarioKey,
      });
      const validIds = new Set(ownEvidence.map((e) => e.id));
      let pool = state.findings;
      const findings: Finding[] = [];
      for (const f of findingsResult.data.findings) {
        const evidenceIds = f.evidenceIds.filter((id) => validIds.has(id));
        if (evidenceIds.length === 0) continue; // structural grounding: a finding must cite this agent's own evidence
        const id = nextFindingId(pool);
        const finding: Finding = { id, agent: agentName, code: f.code, statement: f.statement, evidenceIds, confidence: f.confidence };
        findings.push(finding);
        pool = [...pool, finding];
      }
      await onEvent(nodeName, 'FINDING_CREATED', { findingIds: findings.map((f) => f.id) });
      await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownEvidence.length, findingCount: findings.length });

      return {
        evidence: followUpEvidence,
        findings,
        agentsVisited: [agentName],
        budget: {
          ...zeroBudget(),
          llmCalls: 2,
          toolCalls: chosenTools.length,
          tokensIn: choiceResult.usage.inputTokens + findingsResult.usage.inputTokens,
          tokensOut: choiceResult.usage.outputTokens + findingsResult.usage.outputTokens,
        },
      };
    };
  }

  const paymentAgent = buildSpecialistNode('payment', 'paymentAgent', PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS);
  const reconciliationAgent = buildSpecialistNode('reconciliation', 'reconciliationAgent', RECONCILIATION_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS);
  const riskAgent = buildSpecialistNode('risk', 'riskAgent', RISK_TOOLS, RISK_FOLLOWUP_TOOLS);

  /** Where the parallel `Send` fan-out (graph.ts) converges (docs/03 §5). Every write it could
   * make (`agentsVisited`/`evidence`/`findings`) is already merged by the state reducers once
   * LangGraph runs this node, so it only logs — the doc's "join | code | – | agentsVisited"
   * row means "observes the merge", not "computes it". */
  async function join(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('join', 'NODE_STARTED', {});
    await onEvent('join', 'NODE_COMPLETED', {
      agentsVisited: state.agentsVisited,
      evidenceCount: state.evidence.length,
      findingCount: state.findings.length,
    });
    return {};
  }

  async function resolve(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('resolve', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = state.case!;

    let diagnosis = state.diagnosis;
    let budget = zeroBudget();
    const findings: Finding[] = [];
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
      const finding: Finding = { id: nextFindingId(state.findings), agent: 'payment', code: 'OTHER', statement: narrative.text, evidenceIds: narrative.citedIds, confidence: diagnosis.confidence };
      findings.push(finding);
      diagnosis = { ...diagnosis, narrative: narrative.text, supportingFindingIds: [finding.id] };
      await onEvent('resolve', 'FINDING_CREATED', { findingIds: [finding.id] });
    }

    const proposal = buildProposal(diagnosis, caseState, []);
    await onEvent('resolve', 'PROPOSAL_CREATED', { diagnosis, proposal });
    await onEvent('resolve', 'NODE_COMPLETED', {});
    return { diagnosis, proposal, findings, budget };
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

  return {
    loadCase,
    triage,
    diagnose,
    plan,
    paymentAgent,
    reconciliationAgent,
    riskAgent,
    join,
    resolve,
    policyGate,
    awaitApproval,
    execute,
    closeBlocked,
    closeRejected,
    closeEscalated,
  };
}
