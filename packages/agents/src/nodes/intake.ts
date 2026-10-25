/** Nodes that read the case and decide the path: loadCase, triage, diagnose (J6), plan (J2). */
import { choice, loadCaseState, noul } from '@payops/core';
import { AGENT_NAMES, FAST_PATH, zeroBudget, type Diagnosis, type InvestigationPlan } from '@payops/shared';
import { buildCaseBrief } from '../brief';
import { choosePlanSpecialists } from '../planning';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import { narrativeFor } from '../templates';
import { BASELINE_TOOLS } from '../tools';
import { PRIMARY_HYPOTHESIS_CRITERIA, ROOT_CAUSE_CRITERIA } from './criteria';
import { errorMessage, evidenceFrom, failedJevBudget, jevBudget, type NodeContext } from './shared';

export function buildIntakeNodes({ core, decision, onEvent, guardBudget }: NodeContext) {
  async function loadCase(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('loadCase', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    await onEvent('loadCase', 'NODE_COMPLETED', { entityRefs: caseState.case.entityRefs });
    return { entityRefs: caseState.case.entityRefs, status: 'INVESTIGATING' };
  }

  /** Gathers every baseline tool's evidence up front (D038), so the fast path still has evidence to cite. */
  async function triage(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('triage', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = buildCaseBrief(caseState);
    const evidence = evidenceFrom(state.evidence, BASELINE_TOOLS.map((t) => t.run(caseState)), 'triage');
    await onEvent('triage', 'TOOL_COMPLETED', { tools: BASELINE_TOOLS.map((t) => t.name), evidenceIds: evidence.map((e) => e.id) });
    await onEvent('triage', 'NODE_COMPLETED', { brief });
    return await guardBudget('triage', state, { case: brief, evidence, budget: { ...zeroBudget(), toolCalls: BASELINE_TOOLS.length } });
  }

  /** J6: a confident Jev answer with evidence to cite takes the fast path; anything else goes to the full investigation. */
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
      const fast =
        confidence >= FAST_PATH.minConfidence &&
        result.answers.needs_human.noul <= FAST_PATH.maxNeedsHuman &&
        result.answers.evidence_consistent.noul > FAST_PATH.minConsistent &&
        narrativeFor(result.answers.root_cause.choice, state.evidence).citedIds.length > 0;
      const diagnosis: Diagnosis | null = fast
        ? { rootCause: result.answers.root_cause.choice, narrative: '', confidence, supportingFindingIds: [], path: 'FAST' }
        : null;
      await onEvent('diagnose', 'NODE_COMPLETED', { path: fast ? 'FAST' : 'FULL', rootCause: result.answers.root_cause.choice, confidence });
      return await guardBudget('diagnose', state, { diagnosis, budget: jevBudget(result.usage) });
    } catch (err) {
      await onEvent('diagnose', 'NODE_COMPLETED', { path: 'FULL', fallback: true, error: errorMessage(err) });
      return await guardBudget('diagnose', state, { diagnosis: null, budget: failedJevBudget() });
    }
  }

  /** J2: which specialists the full path needs. A targeted re-round (non-empty gaps) skips Jev and reruns the specialists that own the gaps (D041). */
  async function plan(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('plan', 'NODE_STARTED', {});
    const brief = state.case!;

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
      const investigationPlan: InvestigationPlan = { primaryHypothesis: result.answers.primary_hypothesis.choice, specialists, routedBy: 'JEV', confidence };
      await onEvent('plan', 'NODE_COMPLETED', { specialists, routedBy: 'JEV', primaryHypothesis: investigationPlan.primaryHypothesis });
      return await guardBudget('plan', state, { investigationPlan, investigationRound: state.investigationRound + 1, budget: jevBudget(result.usage) });
    } catch (err) {
      // Fallback: run every specialist rather than guess.
      const investigationPlan: InvestigationPlan = { primaryHypothesis: 'UNKNOWN', specialists: [...AGENT_NAMES], routedBy: 'DEFAULT_ALL', confidence: 0 };
      await onEvent('plan', 'NODE_COMPLETED', { specialists: investigationPlan.specialists, routedBy: 'DEFAULT_ALL', fallback: true, error: errorMessage(err) });
      return await guardBudget('plan', state, { investigationPlan, investigationRound: state.investigationRound + 1, budget: failedJevBudget() });
    }
  }

  return { loadCase, triage, diagnose, plan };
}
