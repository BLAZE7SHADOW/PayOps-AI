/** `resolve`: diagnose (full path) or write the template narrative (fast path), let code check the cause, build the proposal. */
import { loadCaseState } from '@payops/core';
import { estimateCallCostUsd, zeroBudget, type Diagnosis, type Finding } from '@payops/shared';
import { buildResolveContext } from '../context';
import { CODE_OVERRIDE_CONFIDENCE, reconcileDiagnosis } from '../grounding/candidates';
import { survivingFindings } from '../grounding';
import { buildProposal } from '../proposal';
import { nextFindingId } from '../run-ids';
import { DiagnosisSchema } from '../schemas';
import type { PayOpsStateType, PayOpsUpdate } from '../state';
import { narrativeFor } from '../templates';
import { FOLLOWUP_TOOLS } from '../tools';
import { errorMessage, evidenceFrom, toAttemptHistory, type NodeContext } from './shared';

export function buildResolveNode({ core, llm, onEvent, guardBudget }: NodeContext) {
  async function resolve(state: PayOpsStateType): Promise<PayOpsUpdate> {
    await onEvent('resolve', 'NODE_STARTED', {});
    const caseState = await loadCaseState(core.db, core.gateway, state.caseId, core.clock.now());
    const brief = state.case!;

    let diagnosis = state.diagnosis;
    let budget = zeroBudget();
    const findings: Finding[] = [];
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
      // No diagnosis can be built without the model. Nothing downstream can act on a missing one, and no
      // resolution exists yet, so the case itself is escalated (same route as a budget-guard trip).
      let result;
      try {
        result = await llm.invokeStructured(DiagnosisSchema, resolveContext.messages, { node: 'resolve', callIndex: 0, scenarioKey: state.scenarioKey });
      } catch (err) {
        const message = `Gemini call failed while diagnosing the case: ${errorMessage(err)}`;
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
      // Fast path: a code template writes the narrative, no model call.
      const narrative = narrativeFor(diagnosis.rootCause, state.evidence);
      const finding: Finding = { id: nextFindingId(state.findings), agent: 'payment', code: 'OTHER', statement: narrative.text, evidenceIds: narrative.citedIds, confidence: diagnosis.confidence };
      findings.push(finding);
      diagnosis = { ...diagnosis, narrative: narrative.text, supportingFindingIds: [finding.id] };
      await onEvent('resolve', 'FINDING_CREATED', { findingIds: [finding.id] });
    }

    // A fix that validates does not prove the stated cause was right, so code checks the cause against the
    // evidence (D063, D064). A downstream or wrong label with one supported cause is replaced; one with none
    // or several becomes an escalation. The settlement checks need `getFeeBreakdown`, which the model may not
    // have asked for, so code fetches it rather than read a missing lookup as "no evidence".
    const missingCheckTools = FOLLOWUP_TOOLS.filter((t) => t.name === 'getFeeBreakdown' && !state.evidence.some((e) => e.source === t.name));
    const topUpEvidence = evidenceFrom(state.evidence, missingCheckTools.map((t) => t.run(caseState)), 'resolve');
    const checkedEvidence = [...state.evidence, ...topUpEvidence];
    const reconciliation = reconcileDiagnosis(diagnosis.rootCause, checkedEvidence);
    diagnosis = applyReconciliation(diagnosis, reconciliation, checkedEvidence, [...state.findings, ...findings], findings);

    const proposal = buildProposal(diagnosis, caseState, toAttemptHistory(state.history));
    await onEvent('resolve', 'PROPOSAL_CREATED', { diagnosis, proposal, rootCauseCheck: reconciliation });
    await onEvent('resolve', 'NODE_COMPLETED', {});
    return await guardBudget('resolve', state, { diagnosis, proposal, findings, budget, evidence: topUpEvidence });
  }

  return { resolve };
}

/**
 * REPLACE: code substitutes the cause and lowers confidence below the policy threshold, so a person
 * approves. ESCALATE: the cause becomes UNKNOWN with the reason and the candidates. Adds any new finding to `out`.
 */
function applyReconciliation(
  diagnosis: Diagnosis,
  reconciliation: ReturnType<typeof reconcileDiagnosis>,
  evidence: Parameters<typeof narrativeFor>[1],
  existingFindings: readonly Finding[],
  out: Finding[],
): Diagnosis {
  if (reconciliation.kind === 'REPLACE') {
    const replaced = narrativeFor(reconciliation.rootCause, evidence);
    const finding: Finding = { id: nextFindingId(existingFindings), agent: 'payment', code: 'OTHER', statement: replaced.text, evidenceIds: replaced.citedIds, confidence: CODE_OVERRIDE_CONFIDENCE };
    out.push(finding);
    return {
      ...diagnosis,
      rootCause: reconciliation.rootCause,
      narrative: `${replaced.text} Corrected by code: ${reconciliation.reason}`,
      confidence: CODE_OVERRIDE_CONFIDENCE,
      supportingFindingIds: [finding.id],
    };
  }
  if (reconciliation.kind === 'ESCALATE') {
    const unknown = narrativeFor('UNKNOWN', evidence);
    const options = reconciliation.candidates.length > 0 ? ` Causes the evidence supports: ${reconciliation.candidates.join(', ')}.` : ' The evidence supports no known cause.';
    return { ...diagnosis, rootCause: 'UNKNOWN', narrative: `${unknown.text} ${reconciliation.reason}${options}`, supportingFindingIds: [] };
  }
  return diagnosis;
}
