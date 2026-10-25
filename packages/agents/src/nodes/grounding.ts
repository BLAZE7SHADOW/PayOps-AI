/** J4: structural checks in code, then one batched Jev call on the surviving findings. */
import { applyGroundingRules, applyStructuralGrounding, buildGroundingRequest, supportKey, type SupportAnswer } from '../grounding';
import type { GroundingReport } from '@payops/shared';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import { errorMessage, failedJevBudget, jevBudget, type NodeContext } from './shared';

export function buildGroundingNode({ decision, onEvent, guardBudget }: NodeContext) {
  /**
   * `state.findings` only ever grows, so a dropped finding is not removed: `grounding.violations` records
   * the drop and `resolve` filters by it before building any prompt. If Jev fails, only the structural
   * pass applies, the report asks for human review, and no extra round is requested (D041).
   */
  async function groundCheck(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('groundCheck', 'NODE_STARTED', {});
    const evidenceById = new Map(state.evidence.map((e) => [e.id, e]));
    const structural = applyStructuralGrounding(state.findings, evidenceById);
    const report = (rules: ReturnType<typeof applyGroundingRules>): GroundingReport => ({
      checked: state.findings.length,
      violations: rules.violations,
      sufficient: rules.sufficient,
      needsHumanReview: rules.needsHumanReview,
    });

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
      const rules = applyGroundingRules({
        findings: state.findings,
        structuralViolations: structural.violations,
        semanticAnswers,
        sufficientNoul: sufficientAnswer && sufficientAnswer.type === 'noul' ? sufficientAnswer.noul : 1,
        agentsVisited: state.agentsVisited,
        investigationRound: state.investigationRound,
      });
      const grounding = report(rules);
      await onEvent('groundCheck', 'NODE_COMPLETED', { violations: grounding.violations, sufficient: rules.sufficient, gaps: rules.gaps });
      return await guardBudget('groundCheck', state, { grounding, gaps: rules.gaps, budget: jevBudget(result.usage) });
    } catch (err) {
      const rules = applyGroundingRules({
        findings: state.findings,
        structuralViolations: structural.violations,
        semanticAnswers: null,
        sufficientNoul: null,
        agentsVisited: state.agentsVisited,
        investigationRound: state.investigationRound,
      });
      const grounding = report(rules);
      await onEvent('groundCheck', 'NODE_COMPLETED', { violations: grounding.violations, fallback: true, error: errorMessage(err) });
      return await guardBudget('groundCheck', state, { grounding, gaps: [], budget: failedJevBudget() });
    }
  }

  return { groundCheck };
}
