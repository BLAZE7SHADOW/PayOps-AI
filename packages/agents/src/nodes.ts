/**
 * Graph nodes (docs/03-agent-system.md §5). Phase 3's single `investigate` node is split
 * (Phase 4 task 3) into a `plan` node (J2) that routes to Payment/Reconciliation/Risk
 * specialists via LangGraph `Send`, which converge on `join` before `groundCheck` (J4, Phase 4
 * task 6) and then `resolve` — replan is still a later Phase 5 task.
 * `execute` folds the doc's execute → validate → close into one call to
 * `resolutions.finish()`, which already runs that exact sequence for a person's proposal; the
 * agent takes the same code path, just with `onFailure: 'ESCALATE'` instead of reopening the
 * case for a person to retry (docs/06-phases.md Phase 3: "No replan yet (FAIL → escalate)").
 *
 * Simplifications kept, and recorded in docs/DECISIONS.md: `EvidenceItem.stepId` holds the
 * node name rather than a specific `agent_steps` row id; the agent's `AttemptHistory` is always
 * empty (a fresh run rarely follows a failed manual attempt in the seeded demo data); `triage`
 * still gathers the combined baseline evidence for every group up front (D038), so the fast path
 * (`diagnose` → `resolve`, which never runs `plan`, the specialists or `groundCheck`) still has
 * evidence to cite.
 */
import { interrupt } from '@langchain/langgraph';
import { agentWriteContext, choice, loadCaseState, noul, score, type AttemptHistory, type CaseState } from '@payops/core';
import {
  addBudgets,
  AGENT_BUDGET_LIMITS,
  AGENT_NAMES,
  estimateCallCostUsd,
  zeroBudget,
  type AgentApprovalDecision,
  type AgentName,
  type AttemptSummary,
  type Diagnosis,
  type EvidenceItem,
  type Finding,
  type GroundingReport,
  type InvestigationPlan,
  type ReplanStrategy,
  type RiskAssessment,
  type RootCause,
  type RunBudget,
  type RunStatus,
} from '@payops/shared';
import type { AgentDeps } from './deps';
import { buildCaseBrief } from './brief';
import { choosePlanSpecialists } from './planning';
import {
  applyGroundingRules,
  applyStructuralGrounding,
  buildGroundingRequest,
  supportKey,
  survivingFindings,
  type SupportAnswer,
} from './grounding';
import { buildProposal } from './proposal';
import { buildResolveContext, buildSpecialistContext, sliceEvidenceForAgent } from './context';
import { extractRiskSignals, bucketRiskSignals, RISK_SCORE_CRITERIA, rulesOnlyRiskTier } from './risk';
import { combineRiskScores } from './risk.weights';
import { narrativeFor } from './templates';
import { DiagnosisSchema, FindingsSchema, buildFollowUpChoiceSchema } from './schemas';
import type { PayOpsStateType, PayOpsUpdate } from './state';
import {
  BASELINE_TOOLS,
  PAYMENT_FOLLOWUP_TOOLS,
  PAYMENT_TOOLS,
  RECONCILIATION_FOLLOWUP_TOOLS,
  RECONCILIATION_TOOLS,
  RISK_TOOLS,
  type ToolDef,
} from './tools';
import { nextEvidenceId, nextFindingId } from './run-ids';
import { checkBudgetGuard } from './budget-guard';

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

/** J5's `strategy` Choice (docs/03 §4 "J5", §13 "Replan loop"). */
const REPLAN_STRATEGY_CRITERIA: Record<ReplanStrategy, string> = {
  retry_same_action: 'The same action set should work if tried again -- the failure looks transient rather than a wrong choice.',
  alternative_action: 'A different action set from the catalog would fix this case instead of the one just tried.',
  reinvestigate: 'The diagnosis itself may be wrong; another investigation round is needed before proposing anything else.',
  escalate_to_human: 'This needs a person to review rather than another automatic attempt.',
};

/** `AttemptSummary` (agent state) -> `AttemptHistory` (core recommendation input, docs/DECISIONS.md
 * D047): every entry here was built by `replan`, which only ever runs after a validated attempt
 * (an `execute` failure escalates directly, never reaching `replan`), so `status` is always
 * `'VALIDATED'` by construction. */
function toAttemptHistory(history: readonly AttemptSummary[]): AttemptHistory[] {
  return history.map((h) => ({ actionTypes: h.actions.map((a) => a.type), status: 'VALIDATED', verdict: h.verdict }));
}

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

  /**
   * Budget guard (docs/06-phases.md Phase 5 task 5, docs/DECISIONS.md D049). Called at every
   * node on the pre-`policyGate` path (docs/03 §5's node order up to and including `resolve`) --
   * before `policyGate` ever creates a resolution row, so an escalation here has nothing to
   * close but the case itself (`closeEscalated` below, `resolution.service.ts`'s
   * `escalateWithoutProposal`). Not applied past `policyGate`: once a resolution exists, the
   * replan loop's own attempt cap (`AGENT_BUDGET_LIMITS.maxAttempts`) and confidence floor
   * already bound further Jev/LLM spend (D049 records this as a deliberate scope, not a gap).
   * The call that pushes the run over a limit still completes -- this can only stop the *next*
   * one -- which is the normal shape for a budget guard checked after the fact, not before.
   */
  async function guardBudget(nodeName: string, state: PayOpsStateType, update: PayOpsUpdate): Promise<PayOpsUpdate> {
    const total = addBudgets(state.budget ?? zeroBudget(), (update.budget ?? zeroBudget()) as RunBudget);
    const guard = checkBudgetGuard(total);
    if (!guard.exceeded) return update;
    await onEvent(nodeName, 'NODE_COMPLETED', { budgetExceeded: true, reason: guard.reason, budget: total });
    return { ...update, status: 'ESCALATED', error: guard.reason };
  }

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
    return await guardBudget('triage', state, { case: brief, evidence, budget: { ...zeroBudget(), toolCalls: BASELINE_TOOLS.length } });
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
      return await guardBudget('diagnose', state, {
        diagnosis,
        budget: {
          ...zeroBudget(),
          jevCalls: 1,
          tokensIn: result.usage.input_tokens,
          tokensOut: result.usage.output_tokens,
          costUsd: estimateCallCostUsd('jev', result.usage.input_tokens, result.usage.output_tokens),
        },
      });
    } catch (err) {
      await onEvent('diagnose', 'NODE_COMPLETED', { path: 'FULL', fallback: true, error: err instanceof Error ? err.message : String(err) });
      return await guardBudget('diagnose', state, { diagnosis: null, budget: { ...zeroBudget(), jevCalls: 1 } });
    }
  }

  /** J2 (docs/03 §4 "J2"): decide which specialists the full path needs. Only reached when
   * `diagnose` did not resolve fast (see the header note on why `triage` still gathers
   * combined baseline evidence up front). */
  async function plan(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('plan', 'NODE_STARTED', {});
    const brief = state.case!;

    // Targeted re-round (docs/03 §5 "groundCheck -> plan", §4 "J4"): `groundCheck` only ever
    // populates `gaps` when it wants another round, so a non-empty `gaps` here means "skip J2,
    // re-run exactly the specialists that own the gaps" -- the gap already says which agents are
    // missing evidence, so asking Jev again would just be re-deriving the same answer at the
    // cost of a call (docs/DECISIONS.md D041). This still counts as one more `plan` visit for
    // the `investigationRound` cap, same as the first, JEV-routed call below.
    if (state.gaps.length > 0) {
      const specialists = AGENT_NAMES.filter((name) => state.gaps.some((g) => g.agent === name));
      const investigationPlan: InvestigationPlan = {
        primaryHypothesis: state.investigationPlan?.primaryHypothesis ?? 'UNKNOWN',
        specialists,
        routedBy: 'GAP_TARGETED',
        confidence: state.investigationPlan?.confidence ?? 0,
      };
      await onEvent('plan', 'NODE_COMPLETED', { specialists, routedBy: 'GAP_TARGETED', targeted: true, gaps: state.gaps });
      return await guardBudget('plan', state, { investigationPlan, investigationRound: state.investigationRound + 1 });
    }

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
      return await guardBudget('plan', state, {
        investigationPlan,
        investigationRound: state.investigationRound + 1,
        budget: {
          ...zeroBudget(),
          jevCalls: 1,
          tokensIn: result.usage.input_tokens,
          tokensOut: result.usage.output_tokens,
          costUsd: estimateCallCostUsd('jev', result.usage.input_tokens, result.usage.output_tokens),
        },
      });
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
      return await guardBudget('plan', state, { investigationPlan, investigationRound: state.investigationRound + 1, budget: { ...zeroBudget(), jevCalls: 1 } });
    }
  }

  /**
   * Builds `paymentAgent` / `reconciliationAgent`, each running the same two-stage pattern
   * Phase 3's `investigate` used (docs/03 §2): baseline evidence for this group already exists
   * from `triage`, so the specialist only runs its own follow-up pass (bounded LLM call #1, up
   * to `AGENT_BUDGET_LIMITS.maxFollowupToolCalls` tools from its own group) then emits findings
   * (LLM call #2) tagged with its own `AgentName`. When the group has no evidence to reason
   * over, both LLM calls are skipped and the specialist legitimately contributes nothing.
   * `riskAgent` (below, Phase 4 task 5) is deliberately not built from this factory — J3 is code
   * bucketing + one Jev call + code combination, not this two-LLM-call shape.
   */
  function buildSpecialistNode(agentName: AgentName, nodeName: string, ownTools: readonly ToolDef[], followUpTools: readonly ToolDef[]) {
    const followUpSchema = buildFollowUpChoiceSchema(followUpTools);
    return async function specialistNode(state: PayOpsStateType): Promise<PayOpsUpdate> {
      await onEvent(nodeName, 'NODE_STARTED', {});
      const ownBaseline = sliceEvidenceForAgent(state.evidence, ownTools);

      if (!followUpSchema || ownBaseline.length === 0) {
        await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownBaseline.length, findingCount: 0, skipped: true });
        return { agentsVisited: [agentName] };
      }

      const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
      const brief = state.case!;

      // Gemini timeout/error fallback (docs/06-phases.md Phase 5 task 6): unlike a Jev decision
      // point, a specialist's two LLM calls have no code-computed answer to fall back to -- the
      // safe default is the same one an empty evidence group already gets above ("this
      // specialist contributes nothing"), not a crash of the whole investigation. The other
      // specialists, `groundCheck` and `resolve` all already tolerate a specialist contributing
      // zero evidence/findings, so this never leaves the graph in an undefined state.
      try {
        const followUpContext = buildSpecialistContext({
          agent: agentName,
          callType: 'followUp',
          brief,
          evidence: state.evidence,
          ownTools,
          followUpTools,
        });
        const choiceResult = await llm.invokeStructured(followUpSchema, followUpContext.messages, {
          node: nodeName,
          callIndex: 0,
          scenarioKey: state.scenarioKey,
        });
        const wanted = choiceResult.data.followUps.slice(0, AGENT_BUDGET_LIMITS.maxFollowupToolCalls);
        await onEvent(nodeName, 'LLM_CALLED', {
          call: 'followUps',
          followUps: wanted,
          usage: choiceResult.usage,
          // docs/03 §8: "every built context is hashed and its token estimate stored on the agentStep".
          contextTokenEstimate: followUpContext.tokenEstimate,
          contextHash: followUpContext.contentHash,
        });

        const chosenTools = followUpTools.filter((t) => wanted.some((w) => w.tool === t.name));
        const followUpEvidence = evidenceFrom(state.evidence, caseState, chosenTools, nodeName);
        if (followUpEvidence.length > 0) {
          await onEvent(nodeName, 'TOOL_COMPLETED', { tools: chosenTools.map((t) => t.name), evidenceIds: followUpEvidence.map((e) => e.id) });
        }
        const ownEvidence = [...ownBaseline, ...followUpEvidence];

        const findingsContext = buildSpecialistContext({
          agent: agentName,
          callType: 'findings',
          brief,
          evidence: [...state.evidence, ...followUpEvidence],
          ownTools,
        });
        const findingsResult = await llm.invokeStructured(FindingsSchema, findingsContext.messages, {
          node: nodeName,
          callIndex: 1,
          scenarioKey: state.scenarioKey,
        });
        await onEvent(nodeName, 'LLM_CALLED', {
          call: 'findings',
          usage: findingsResult.usage,
          contextTokenEstimate: findingsContext.tokenEstimate,
          contextHash: findingsContext.contentHash,
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

        const tokensIn = choiceResult.usage.inputTokens + findingsResult.usage.inputTokens;
        const tokensOut = choiceResult.usage.outputTokens + findingsResult.usage.outputTokens;
        return {
          evidence: followUpEvidence,
          findings,
          agentsVisited: [agentName],
          budget: {
            ...zeroBudget(),
            llmCalls: 2,
            toolCalls: chosenTools.length,
            tokensIn,
            tokensOut,
            costUsd: estimateCallCostUsd('gemini', tokensIn, tokensOut),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownBaseline.length, findingCount: 0, fallback: true, error: message });
        return { agentsVisited: [agentName] };
      }
    };
  }

  const paymentAgent = buildSpecialistNode('payment', 'paymentAgent', PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS);
  const reconciliationAgent = buildSpecialistNode('reconciliation', 'reconciliationAgent', RECONCILIATION_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS);
  /**
   * `riskAgent` (docs/03-agent-system.md §4 "J3", §5 node table). Deliberately not built from
   * `buildSpecialistNode`: J3 is code bucketing + one batched Jev `score()` call + code
   * combination, not an LLM tool-choice pass. All four risk tools are baseline (tools.ts), so
   * `triage` has already gathered this agent's evidence before `riskAgent` ever runs — there is
   * no follow-up tool round here to bound with an LLM call.
   *
   * Gemini only enters as a fallback, per the node table's "(+LLM only if confidence < 0.5)":
   * when Jev's mean confidence across the four Scores is under 0.5, one findings-only LLM call
   * (the same `buildSpecialistContext`/`FindingsSchema` shape the other specialists use for
   * their second call) writes up what the raw evidence shows, so a human reviewing an uncertain
   * HIGH/CRITICAL tier has more than four bare numbers to go on. On Jev's own error/timeout, the
   * J3 fallback (docs/03 §4 "Jev adapter contract": "J3 → rules-only tier") skips Jev and the
   * LLM entirely — `rulesOnlyRiskTier` (risk.ts) never leaves `state.risk` unset.
   */
  async function riskAgent(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('riskAgent', 'NODE_STARTED', {});
    const ownEvidence = sliceEvidenceForAgent(state.evidence, RISK_TOOLS);
    if (ownEvidence.length === 0) {
      // No order to read signals from at all (docs/03 §2: baseline tools found nothing) — same
      // "legitimately contributes nothing" shape the other specialists use.
      await onEvent('riskAgent', 'NODE_COMPLETED', { skipped: true });
      return { agentsVisited: ['risk'] };
    }

    const signals = extractRiskSignals(ownEvidence);
    const buckets = bucketRiskSignals(signals);

    let risk: RiskAssessment;
    let budget = zeroBudget();
    try {
      const result = await decision.ask({
        tag: 'J3_RISK',
        state: buckets,
        questions: {
          velocity_abuse: score('How much do the recent attempts, devices and cards look like automated abuse rather than one person paying?', RISK_SCORE_CRITERIA.velocity_abuse),
          identity_mismatch: score("How much does this customer's identity look inconsistent (new account, mismatched device/card location)?", RISK_SCORE_CRITERIA.identity_mismatch),
          chargeback_pattern: score("How much does this customer's recorded risk-flag history suggest a dispute pattern?", RISK_SCORE_CRITERIA.chargeback_pattern),
          merchant_exposure: score("How exposed is this merchant to settlement disputes recently?", RISK_SCORE_CRITERIA.merchant_exposure),
        },
      });
      const scores = {
        velocity_abuse: result.answers.velocity_abuse.score,
        identity_mismatch: result.answers.identity_mismatch.score,
        chargeback_pattern: result.answers.chargeback_pattern.score,
        merchant_exposure: result.answers.merchant_exposure.score,
      };
      const confidences = [
        result.answers.velocity_abuse.confidence,
        result.answers.identity_mismatch.confidence,
        result.answers.chargeback_pattern.confidence,
        result.answers.merchant_exposure.confidence,
      ];
      const meanConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      risk = combineRiskScores(scores, meanConfidence);
      await onEvent('riskAgent', 'DECISION_MADE', { tag: 'J3_RISK', answers: result.answers, usage: result.usage, tier: risk.tier });
      budget = {
        ...zeroBudget(),
        jevCalls: 1,
        tokensIn: result.usage.input_tokens,
        tokensOut: result.usage.output_tokens,
        costUsd: estimateCallCostUsd('jev', result.usage.input_tokens, result.usage.output_tokens),
      };

      const findings: Finding[] = [];
      let llmFallbackRan = false;
      if (meanConfidence < 0.5) {
        llmFallbackRan = true;
        const brief = state.case!;
        const findingsContext = buildSpecialistContext({ agent: 'risk', callType: 'findings', brief, evidence: state.evidence, ownTools: RISK_TOOLS });
        const findingsResult = await llm.invokeStructured(FindingsSchema, findingsContext.messages, {
          node: 'riskAgent',
          callIndex: 0,
          scenarioKey: state.scenarioKey,
        });
        await onEvent('riskAgent', 'LLM_CALLED', {
          call: 'findings',
          usage: findingsResult.usage,
          contextTokenEstimate: findingsContext.tokenEstimate,
          contextHash: findingsContext.contentHash,
        });
        const validIds = new Set(ownEvidence.map((e) => e.id));
        let pool = state.findings;
        for (const f of findingsResult.data.findings) {
          const evidenceIds = f.evidenceIds.filter((id) => validIds.has(id));
          if (evidenceIds.length === 0) continue; // structural grounding, same rule buildSpecialistNode uses
          const id = nextFindingId(pool);
          const finding: Finding = { id, agent: 'risk', code: f.code, statement: f.statement, evidenceIds, confidence: f.confidence };
          findings.push(finding);
          pool = [...pool, finding];
        }
        if (findings.length > 0) await onEvent('riskAgent', 'FINDING_CREATED', { findingIds: findings.map((f) => f.id) });
        budget = {
          ...budget,
          llmCalls: 1,
          tokensIn: budget.tokensIn + findingsResult.usage.inputTokens,
          tokensOut: budget.tokensOut + findingsResult.usage.outputTokens,
          costUsd: budget.costUsd + estimateCallCostUsd('gemini', findingsResult.usage.inputTokens, findingsResult.usage.outputTokens),
        };
      }

      await onEvent('riskAgent', 'NODE_COMPLETED', { tier: risk.tier, meanConfidence: risk.meanConfidence, findingCount: findings.length });
      // Only touch the `findings` channel when the LLM fallback actually ran -- a confident
      // Jev-only pass never calls the LLM at all, so there is nothing (not even an empty array)
      // to report; once the fallback runs, `findings` is meaningful even if every candidate was
      // dropped by structural grounding (an empty array, not an absent key).
      return llmFallbackRan ? { risk, findings, agentsVisited: ['risk'], budget } : { risk, agentsVisited: ['risk'], budget };
    } catch (err) {
      // J3 fallback (docs/03 §4 "Jev adapter contract"): rules-only tier, no LLM. Never leaves
      // `state.risk` unset — a run must always have a risk assessment once Risk has run.
      risk = rulesOnlyRiskTier(signals);
      await onEvent('riskAgent', 'NODE_COMPLETED', { tier: risk.tier, fallback: true, error: err instanceof Error ? err.message : String(err) });
      return { risk, agentsVisited: ['risk'], budget: { ...zeroBudget(), jevCalls: 1 } };
    }
  }

  /** Where the parallel `Send` fan-out (graph.ts) converges (docs/03 §5). Every write it could
   * make (`agentsVisited`/`evidence`/`findings`) is already merged by the state reducers once
   * LangGraph runs this node, so it only logs — the doc's "join | code | – | agentsVisited"
   * row means "observes the merge", not "computes it". `groundCheck` (below) is the next node
   * and does the real work. */
  async function join(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('join', 'NODE_STARTED', {});
    await onEvent('join', 'NODE_COMPLETED', {
      agentsVisited: state.agentsVisited,
      evidenceCount: state.evidence.length,
      findingCount: state.findings.length,
    });
    // The specialists' own tool/LLM spend only becomes visible on the merged state once their
    // parallel `Send` branches converge here (docs/DECISIONS.md D049) -- this is the first point
    // after `plan` that can see the round's real total, so the budget guard is checked here.
    return await guardBudget('join', state, {});
  }

  /**
   * J4 (docs/03-agent-system.md §4 "J4", §7 "Evidence model"), Phase 4 task 6. Two passes:
   * structural predicates first (code, always runs, `grounding.ts` + `grounding/predicates.ts`),
   * then one batched Jev call -- a `support` Choice per structurally-sound finding plus one
   * `sufficient` Noul over the whole case. `state.findings` is append-only (state.ts), so a
   * "dropped" finding is never physically removed here: `grounding.violations` is the drop
   * record, and `resolve` (below) filters by it before building any context or letting the LLM
   * cite a finding -- this is what makes a grounding-caught finding "never reach resolve" even
   * though the array it lives in never shrinks.
   */
  async function groundCheck(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('groundCheck', 'NODE_STARTED', {});
    const evidenceById = new Map(state.evidence.map((e) => [e.id, e]));
    const structural = applyStructuralGrounding(state.findings, evidenceById);

    const { state: jevState, questions } = buildGroundingRequest(structural.sound, evidenceById);
    try {
      const result = await decision.ask({ tag: 'J4_GROUND', state: jevState, questions });
      await onEvent('groundCheck', 'DECISION_MADE', { tag: 'J4_GROUND', answers: result.answers, usage: result.usage });

      const semanticAnswers: SupportAnswer[] = structural.sound.map((f) => {
        const answer = result.answers[supportKey(f.id)];
        return answer && answer.type === 'choice'
          ? { findingId: f.id, choice: answer.choice as SupportAnswer['choice'], confidence: answer.confidence }
          : { findingId: f.id, choice: 'not_enough_evidence', confidence: 0 };
      });
      const sufficientAnswer = result.answers.sufficient;
      const sufficientNoul = sufficientAnswer && sufficientAnswer.type === 'noul' ? sufficientAnswer.noul : 1;

      const rules = applyGroundingRules({
        findings: state.findings,
        structuralViolations: structural.violations,
        semanticAnswers,
        sufficientNoul,
        agentsVisited: state.agentsVisited,
        investigationRound: state.investigationRound,
      });
      const grounding: GroundingReport = { checked: state.findings.length, violations: rules.violations, sufficient: rules.sufficient, needsHumanReview: rules.needsHumanReview };
      await onEvent('groundCheck', 'NODE_COMPLETED', { violations: grounding.violations, sufficient: rules.sufficient, gaps: rules.gaps });
      return await guardBudget('groundCheck', state, {
        grounding,
        gaps: rules.gaps,
        budget: {
          ...zeroBudget(),
          jevCalls: 1,
          tokensIn: result.usage.input_tokens,
          tokensOut: result.usage.output_tokens,
          costUsd: estimateCallCostUsd('jev', result.usage.input_tokens, result.usage.output_tokens),
        },
      });
    } catch (err) {
      // J4 fallback (docs/03 §4 "Jev adapter contract"): "structural check only + mark
      // needsHumanReview" -- semantic checking is skipped entirely (never guessed), and the
      // fallback never adds an extra round on its own (`applyGroundingRules` enforces this by
      // always returning `sufficient: true`, `gaps: []` when `semanticAnswers` is `null`).
      const rules = applyGroundingRules({
        findings: state.findings,
        structuralViolations: structural.violations,
        semanticAnswers: null,
        sufficientNoul: null,
        agentsVisited: state.agentsVisited,
        investigationRound: state.investigationRound,
      });
      const grounding: GroundingReport = { checked: state.findings.length, violations: rules.violations, sufficient: rules.sufficient, needsHumanReview: rules.needsHumanReview };
      await onEvent('groundCheck', 'NODE_COMPLETED', { violations: grounding.violations, fallback: true, error: err instanceof Error ? err.message : String(err) });
      return await guardBudget('groundCheck', state, { grounding, gaps: [], budget: { ...zeroBudget(), jevCalls: 1 } });
    }
  }

  async function resolve(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('resolve', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = state.case!;

    let diagnosis = state.diagnosis;
    let budget = zeroBudget();
    const findings: Finding[] = [];
    // Grounding (docs/03 §4 "J4") already ran between `join` and `resolve` on the full path --
    // `state.grounding` is `null` on the fast path (`diagnose` -> `resolve` directly), where
    // `survivingFindings` is a no-op copy of `state.findings`.
    const groundedFindings = survivingFindings(state.findings, state.grounding?.violations);
    if (!diagnosis) {
      const resolveContext = buildResolveContext({
        brief,
        findings: groundedFindings,
        evidenceCount: state.evidence.length,
        risk: state.risk,
        grounding: state.grounding,
        history: state.history,
      });
      // Gemini timeout/error fallback (docs/06-phases.md Phase 5 task 6): unlike Jev's decision
      // points, there is no code-computed diagnosis to fall back to here -- the fast-path
      // template (`narrativeFor`, the other branch below) only ever runs for a diagnosis Jev (J6)
      // already produced, and this branch is reached precisely because there isn't one. Nothing
      // downstream (`buildProposal`, policy, the validator) can act on a missing diagnosis, so
      // the only defined outcome is the same one a pre-`policyGate` budget-guard trip already
      // uses (docs/DECISIONS.md D049): no resolution has been created yet, so escalate the case
      // itself via `state.error` + `status: 'ESCALATED'`, which `closeEscalated` already handles.
      let result;
      try {
        result = await llm.invokeStructured(DiagnosisSchema, resolveContext.messages, {
          node: 'resolve',
          callIndex: 0,
          scenarioKey: state.scenarioKey,
        });
      } catch (err) {
        const message = `Gemini call failed while diagnosing the case: ${err instanceof Error ? err.message : String(err)}`;
        await onEvent('resolve', 'NODE_COMPLETED', { fallback: true, error: message });
        return { status: 'ESCALATED', error: message };
      }
      diagnosis = { ...result.data, path: 'FULL' };
      budget = {
        ...zeroBudget(),
        llmCalls: 1,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: estimateCallCostUsd('gemini', result.usage.inputTokens, result.usage.outputTokens),
      };
      await onEvent('resolve', 'LLM_CALLED', {
        call: 'diagnosis',
        diagnosis,
        usage: result.usage,
        contextTokenEstimate: resolveContext.tokenEstimate,
        contextHash: resolveContext.contentHash,
      });
    } else if (!diagnosis.narrative) {
      // Fast path: code narrative template, no LLM (docs/03 §4a).
      const narrative = narrativeFor(diagnosis.rootCause, state.evidence);
      const finding: Finding = { id: nextFindingId(state.findings), agent: 'payment', code: 'OTHER', statement: narrative.text, evidenceIds: narrative.citedIds, confidence: diagnosis.confidence };
      findings.push(finding);
      diagnosis = { ...diagnosis, narrative: narrative.text, supportingFindingIds: [finding.id] };
      await onEvent('resolve', 'FINDING_CREATED', { findingIds: [finding.id] });
    }

    const proposal = buildProposal(diagnosis, caseState, toAttemptHistory(state.history));
    await onEvent('resolve', 'PROPOSAL_CREATED', { diagnosis, proposal });
    await onEvent('resolve', 'NODE_COMPLETED', {});
    // Still before `policyGate` creates a resolution row (docs/DECISIONS.md D049), so a trip
    // here also has nothing to close but the case itself.
    return await guardBudget('resolve', state, { diagnosis, proposal, findings, budget });
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

  /**
   * Runs the proposal's actions only (docs/03 §5 "execute"). Phase 3-4 folded execute + validate
   * + close into one `resolutions.finish()` call; Phase 5's replan loop (docs/03 §13, D047)
   * needs to see the validator's verdict before deciding whether to close at all, so `execute`
   * and `validate` are now separate nodes. An execution failure is unchanged from before: it
   * still closes and escalates immediately here, without ever reaching `replan` -- only a
   * validator PARTIAL/FAIL (validate node) is a "failure" `replan` reasons about (docs/03 §4 "J5":
   * "attempt summary ... validator checks that failed").
   */
  async function execute(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('execute', 'NODE_STARTED', { resolutionId: state.resolutionId });
    const write = agentWriteContext(state.caseId, state.runId);
    try {
      const { execution } = await core.resolutions.execute(state.resolutionId!, write);
      await onEvent('execute', 'EXECUTION_STEP', { executions: execution.steps });
      if (!execution.ok) {
        await core.resolutions.closeExecutionFailed(state.resolutionId!, execution, write, { onFailure: 'ESCALATE' });
        await onEvent('execute', 'RUN_COMPLETED', { status: 'ESCALATED' });
        return { executions: execution.steps, status: 'ESCALATED' };
      }
      await onEvent('execute', 'NODE_COMPLETED', {});
      return { executions: execution.steps };
    } catch (err) {
      // A database-layer failure escaping the executor itself (docs/06-phases.md Phase 5 task 6
      // "database serialization conflict during execute") -- not an individual action failing
      // cleanly (that is `execution.ok === false` above, already handled), but the executor
      // unable to even report an outcome. `withSerializationRetry` (packages/core/src/db/
      // retry.ts) already retries a transient 40001 inside `ExecutorService`; anything still
      // thrown here has exhausted that or is a different error entirely -- either way the run
      // must not crash. A resolution already exists (`policyGate` created it), so escalate it
      // directly rather than leaving it open with no defined outcome.
      const message = err instanceof Error ? err.message : String(err);
      await core.resolutions.escalateExecutionError(state.resolutionId!, message, write);
      await onEvent('execute', 'RUN_COMPLETED', { status: 'ESCALATED', fallback: true, error: message });
      return { status: 'ESCALATED', error: message };
    }
  }

  /** Validates the executed resolution against fresh state (docs/03 §5 "validate"). Does not close. */
  async function validate(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('validate', 'NODE_STARTED', { resolutionId: state.resolutionId });
    const result = await core.resolutions.validate(state.resolutionId!);
    const validation = { verdict: result.verdict, checks: result.checks };
    await onEvent('validate', 'VALIDATION_COMPLETED', { validation });
    await onEvent('validate', 'NODE_COMPLETED', {});
    return { validation };
  }

  /** Verdict PASS: close the resolution and resolve (or escalate, if the proposal itself escalates). */
  async function closeResolved(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('closeResolved', 'NODE_STARTED', {});
    const write = agentWriteContext(state.caseId, state.runId);
    await core.resolutions.closeValidated(state.resolutionId!, 'PASS', write, { onFailure: 'ESCALATE' });
    const escalates = (state.proposal?.actions ?? []).some((a) => a.type === 'ESCALATE_TO_HUMAN');
    const status: RunStatus = escalates ? 'ESCALATED' : 'RESOLVED';
    await onEvent('closeResolved', 'RUN_COMPLETED', { status });
    return { status };
  }

  /**
   * J5 (docs/03 §4 "J5", §13 "Replan loop"). Only reached after a PARTIAL/FAIL verdict; the
   * current attempt's resolution is executed and validated but deliberately left un-closed by
   * `validate` (D047) so the case doesn't look ESCALATED/OPEN before this decision is made.
   * Code caps always win over Jev and never spend a call: the attempt cap
   * (`AGENT_BUDGET_LIMITS.maxAttempts`) and a confidence floor of 0.5 both fall through to
   * `escalate_to_human`, matching the J5 fallback in the adapter contract table.
   */
  async function replan(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('replan', 'NODE_STARTED', { attempt: state.attempt });
    const validation = state.validation!;
    const failedChecks = validation.checks.filter((c) => !c.pass).map((c) => c.id);
    const validatorNotes = `Validator ${validation.verdict}: ${failedChecks.length ? failedChecks.join(', ') : 'an invariant'} failed on attempt ${state.attempt}.`;
    const summary: AttemptSummary = { attempt: state.attempt, actions: state.proposal?.actions ?? [], failedChecks, validatorNotes, verdict: validation.verdict };

    if (state.attempt >= AGENT_BUDGET_LIMITS.maxAttempts) {
      await onEvent('replan', 'NODE_COMPLETED', { strategy: 'escalate_to_human', reason: 'attempt cap' });
      return { history: [summary], status: 'ESCALATED' };
    }

    try {
      const result = await decision.ask({
        tag: 'J5_REPLAN',
        state: { attempt: state.attempt, failedChecks, validatorNotes },
        questions: { strategy: choice('What should happen next, given this attempt failed verification?', REPLAN_STRATEGY_CRITERIA) },
      });
      await onEvent('replan', 'DECISION_MADE', { tag: 'J5_REPLAN', answers: result.answers, usage: result.usage });
      const budget = { ...zeroBudget(), jevCalls: 1, tokensIn: result.usage.input_tokens, tokensOut: result.usage.output_tokens };
      // Confidence floor (docs/03 §4 "J5"): "Confidence < 0.5 → escalate_to_human", same as the
      // attempt cap above -- code always overrides a low-confidence answer, never trusts it.
      const strategy: ReplanStrategy = result.answers.strategy.confidence < 0.5 ? 'escalate_to_human' : result.answers.strategy.choice;
      await onEvent('replan', 'NODE_COMPLETED', { strategy, confidence: result.answers.strategy.confidence });
      if (strategy === 'escalate_to_human') {
        return { history: [summary], status: 'ESCALATED', budget };
      }
      await onEvent('replan', 'RUN_REPLANNING', { strategy, nextAttempt: state.attempt + 1 });
      if (strategy === 'reinvestigate') {
        // A fresh investigation round: clear the stale diagnosis so `resolve` runs the full LLM
        // diagnosis path again instead of reusing attempt 1's (possibly wrong) fast-path answer.
        return { history: [summary], diagnosis: null, gaps: [], investigationRound: 0, budget };
      }
      // retry_same_action / alternative_action both go straight back to `resolve`. Both are the
      // same code path today: `resolve` rebuilds the proposal from `recommendedTypes(state,
      // history)` (core/actions/options.ts), which already alternates its own recommendation once
      // a replay is seen to have failed before -- the strategy distinction matters to Jev's
      // reasoning and to what's recorded in `history`, but not to a second branch in this node
      // (see docs/DECISIONS.md D047).
      return { history: [summary], budget };
    } catch (err) {
      // J5 fallback (docs/03 §4 "Jev adapter contract"): "escalate".
      await onEvent('replan', 'NODE_COMPLETED', { strategy: 'escalate_to_human', fallback: true, error: err instanceof Error ? err.message : String(err) });
      return { history: [summary], status: 'ESCALATED', budget: { ...zeroBudget(), jevCalls: 1 } };
    }
  }

  async function closeBlocked(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED', reason: 'BLOCKED by policy' });
    return { status: 'ESCALATED' };
  }

  async function closeRejected(_state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('close', 'RUN_COMPLETED', { status: 'REJECTED' });
    return { status: 'REJECTED' };
  }

  /**
   * Reached three ways (docs/03 §5): `awaitApproval`'s ESCALATE decision (that path's own
   * service call already closed the resolution and case -- `state.validation` is still `null`,
   * since `validate` never ran, so there is nothing more to close here); `replan`'s
   * `escalate_to_human` route (validate did run and left the current attempt un-closed on
   * purpose -- close it now, the same way `closeResolved` closes a PASS); or the budget guard
   * tripping anywhere before `policyGate` (docs/06-phases.md Phase 5 task 5, D049) -- no
   * resolution ever existed, so only the case itself needs to move to ESCALATED.
   */
  async function closeEscalated(state: PayOpsStateType): Promise<PayOpsUpdate> {
    const write = agentWriteContext(state.caseId, state.runId);
    if (state.validation) {
      await core.resolutions.closeValidated(state.resolutionId!, state.validation.verdict, write, { onFailure: 'ESCALATE' });
    } else if (!state.resolutionId && state.error) {
      // Budget guard tripped before `policyGate` ever created a resolution (docs/06-phases.md
      // Phase 5 task 5, docs/DECISIONS.md D049) -- `guardBudget` (above) is the only other writer
      // of `state.error`, and it only runs on the pre-`policyGate` path, so `resolutionId` is
      // reliably still null here. There is no resolution to close, only the case itself.
      await core.resolutions.escalateWithoutProposal(state.caseId, state.error, write);
    }
    // Any other route to this node (`awaitApproval`'s ESCALATE decision, `policyGate`'s BLOCKED
    // tier via `closeBlocked`) already closed the resolution/case elsewhere -- see the header
    // comment above and D047.
    await onEvent('close', 'RUN_COMPLETED', { status: 'ESCALATED', ...(state.error ? { reason: state.error } : {}) });
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
    groundCheck,
    resolve,
    policyGate,
    awaitApproval,
    execute,
    validate,
    closeResolved,
    replan,
    closeBlocked,
    closeRejected,
    closeEscalated,
  };
}
