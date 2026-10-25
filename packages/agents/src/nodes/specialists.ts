/** The three specialists (payment, reconciliation, risk) and the `join` where their parallel branches meet. */
import { loadCaseState, score } from '@payops/core';
import {
  AGENT_BUDGET_LIMITS,
  estimateCallCostUsd,
  zeroBudget,
  type AgentName,
  type Finding,
  type RiskAssessment,
  type RunBudget,
} from '@payops/shared';
import { buildSpecialistContext, sliceEvidenceForAgent } from '../context';
import { RISK_SCORE_CRITERIA, bucketRiskSignals, extractRiskSignals, rulesOnlyRiskTier } from '../risk';
import { combineRiskScores } from '../risk.weights';
import { FindingsSchema, buildFollowUpChoiceSchema } from '../schemas';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import { PAYMENT_FOLLOWUP_TOOLS, PAYMENT_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS, RECONCILIATION_TOOLS, RISK_TOOLS, type ToolDef } from '../tools';
import { buildFindings, errorMessage, evidenceFrom, failedJevBudget, jevBudget, type NodeContext } from './shared';

export function buildSpecialistNodes({ core, llm, decision, onEvent, guardBudget }: NodeContext) {
  /**
   * Payment and reconciliation share one shape: baseline evidence already exists from `triage`, so the
   * specialist asks the model which follow-up tools from its own group it wants (call 1), runs them,
   * then writes findings (call 2). A specialist with no evidence skips both calls. If a call fails it
   * contributes nothing: the rest of the graph already tolerates that.
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

      try {
        const followUpContext = buildSpecialistContext({ agent: agentName, callType: 'followUp', brief, evidence: state.evidence, ownTools, followUpTools });
        const choiceResult = await llm.invokeStructured(followUpSchema, followUpContext.messages, { node: nodeName, callIndex: 0, scenarioKey: state.scenarioKey });
        const wanted = choiceResult.data.followUps.slice(0, AGENT_BUDGET_LIMITS.maxFollowupToolCalls);
        await onEvent(nodeName, 'LLM_CALLED', {
          call: 'followUps',
          followUps: wanted,
          usage: choiceResult.usage,
          contextTokenEstimate: followUpContext.tokenEstimate,
          contextHash: followUpContext.contentHash,
        });

        const chosenTools = followUpTools.filter((t) => wanted.some((w) => w.tool === t.name));
        const followUpEvidence = evidenceFrom(state.evidence, chosenTools.map((t) => t.run(caseState)), nodeName);
        if (followUpEvidence.length > 0) {
          await onEvent(nodeName, 'TOOL_COMPLETED', { tools: chosenTools.map((t) => t.name), evidenceIds: followUpEvidence.map((e) => e.id) });
        }
        const ownEvidence = [...ownBaseline, ...followUpEvidence];

        const findingsContext = buildSpecialistContext({ agent: agentName, callType: 'findings', brief, evidence: [...state.evidence, ...followUpEvidence], ownTools });
        const findingsResult = await llm.invokeStructured(FindingsSchema, findingsContext.messages, { node: nodeName, callIndex: 1, scenarioKey: state.scenarioKey });
        await onEvent(nodeName, 'LLM_CALLED', {
          call: 'findings',
          usage: findingsResult.usage,
          contextTokenEstimate: findingsContext.tokenEstimate,
          contextHash: findingsContext.contentHash,
        });
        const findings = buildFindings(findingsResult.data.findings, agentName, new Set(ownEvidence.map((e) => e.id)), state.findings);
        await onEvent(nodeName, 'FINDING_CREATED', { findingIds: findings.map((f) => f.id) });
        await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownEvidence.length, findingCount: findings.length });

        const tokensIn = choiceResult.usage.inputTokens + findingsResult.usage.inputTokens;
        const tokensOut = choiceResult.usage.outputTokens + findingsResult.usage.outputTokens;
        return {
          evidence: followUpEvidence,
          findings,
          agentsVisited: [agentName],
          budget: { ...zeroBudget(), llmCalls: 2, toolCalls: chosenTools.length, tokensIn, tokensOut, costUsd: estimateCallCostUsd('gemini', tokensIn, tokensOut) },
        };
      } catch (err) {
        await onEvent(nodeName, 'NODE_COMPLETED', { evidenceCount: ownBaseline.length, findingCount: 0, fallback: true, error: errorMessage(err) });
        return { agentsVisited: [agentName] };
      }
    };
  }

  const paymentAgent = buildSpecialistNode('payment', 'paymentAgent', PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS);
  const reconciliationAgent = buildSpecialistNode('reconciliation', 'reconciliationAgent', RECONCILIATION_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS);

  /**
   * J3: code buckets the signals, one Jev call scores them, code combines the scores into a tier. All
   * four risk tools are baseline, so there is no tool-choice step. Gemini only writes findings when Jev's
   * mean confidence is under 0.5. If Jev fails, a rules-only tier is used, so `state.risk` is always set.
   */
  async function riskAgent(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('riskAgent', 'NODE_STARTED', {});
    const ownEvidence = sliceEvidenceForAgent(state.evidence, RISK_TOOLS);
    if (ownEvidence.length === 0) {
      await onEvent('riskAgent', 'NODE_COMPLETED', { skipped: true });
      return { agentsVisited: ['risk'] };
    }

    const signals = extractRiskSignals(ownEvidence);
    try {
      const result = await decision.ask({
        tag: 'J3_RISK',
        state: bucketRiskSignals(signals),
        questions: {
          velocity_abuse: score('How much do the recent attempts, devices and cards look like automated abuse rather than one person paying?', RISK_SCORE_CRITERIA.velocity_abuse),
          identity_mismatch: score("How much does this customer's identity look inconsistent (new account, mismatched device/card location)?", RISK_SCORE_CRITERIA.identity_mismatch),
          chargeback_pattern: score("How much does this customer's recorded risk-flag history suggest a dispute pattern?", RISK_SCORE_CRITERIA.chargeback_pattern),
          merchant_exposure: score('How exposed is this merchant to settlement disputes recently?', RISK_SCORE_CRITERIA.merchant_exposure),
        },
      });
      const { velocity_abuse, identity_mismatch, chargeback_pattern, merchant_exposure } = result.answers;
      const scores = {
        velocity_abuse: velocity_abuse.score,
        identity_mismatch: identity_mismatch.score,
        chargeback_pattern: chargeback_pattern.score,
        merchant_exposure: merchant_exposure.score,
      };
      const confidences = [velocity_abuse, identity_mismatch, chargeback_pattern, merchant_exposure].map((a) => a.confidence);
      const meanConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      const risk: RiskAssessment = combineRiskScores(scores, meanConfidence);
      await onEvent('riskAgent', 'DECISION_MADE', { tag: 'J3_RISK', answers: result.answers, usage: result.usage, tier: risk.tier });
      let budget: RunBudget = jevBudget(result.usage);

      let findings: Finding[] | null = null;
      if (meanConfidence < 0.5) {
        const findingsContext = buildSpecialistContext({ agent: 'risk', callType: 'findings', brief: state.case!, evidence: state.evidence, ownTools: RISK_TOOLS });
        const findingsResult = await llm.invokeStructured(FindingsSchema, findingsContext.messages, { node: 'riskAgent', callIndex: 0, scenarioKey: state.scenarioKey });
        await onEvent('riskAgent', 'LLM_CALLED', {
          call: 'findings',
          usage: findingsResult.usage,
          contextTokenEstimate: findingsContext.tokenEstimate,
          contextHash: findingsContext.contentHash,
        });
        findings = buildFindings(findingsResult.data.findings, 'risk', new Set(ownEvidence.map((e) => e.id)), state.findings);
        if (findings.length > 0) await onEvent('riskAgent', 'FINDING_CREATED', { findingIds: findings.map((f) => f.id) });
        budget = {
          ...budget,
          llmCalls: 1,
          tokensIn: budget.tokensIn + findingsResult.usage.inputTokens,
          tokensOut: budget.tokensOut + findingsResult.usage.outputTokens,
          costUsd: budget.costUsd + estimateCallCostUsd('gemini', findingsResult.usage.inputTokens, findingsResult.usage.outputTokens),
        };
      }

      await onEvent('riskAgent', 'NODE_COMPLETED', { tier: risk.tier, meanConfidence: risk.meanConfidence, findingCount: findings?.length ?? 0 });
      // The findings channel is touched only when the Gemini fallback ran, even if it kept none.
      return findings ? { risk, findings, agentsVisited: ['risk'], budget } : { risk, agentsVisited: ['risk'], budget };
    } catch (err) {
      const risk = rulesOnlyRiskTier(signals);
      await onEvent('riskAgent', 'NODE_COMPLETED', { tier: risk.tier, fallback: true, error: errorMessage(err) });
      return { risk, agentsVisited: ['risk'], budget: failedJevBudget() };
    }
  }

  /** The specialists' combined spend first shows on the merged state here, so the budget guard runs here (D049). */
  async function join(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('join', 'NODE_STARTED', {});
    await onEvent('join', 'NODE_COMPLETED', {
      agentsVisited: state.agentsVisited,
      evidenceCount: state.evidence.length,
      findingCount: state.findings.length,
    });
    return await guardBudget('join', state, {});
  }

  return { paymentAgent, reconciliationAgent, riskAgent, join };
}
