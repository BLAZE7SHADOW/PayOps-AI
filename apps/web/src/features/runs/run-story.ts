import { ACTION_META, type AgentRunItem, type AgentStepItem } from '@payops/shared';
import type { NodeVisit } from './run-flow';

export interface NodeStory {
  summary: string;
  details: string[];
}

function event(visit: NodeVisit, kind: AgentStepItem['kind']): AgentStepItem | undefined {
  return visit.steps.find((step) => step.kind === kind);
}

function completed(visit: NodeVisit): Record<string, unknown> {
  return visit.steps.findLast((step) => step.kind === 'NODE_COMPLETED')?.payload ?? {};
}

function score(answers: unknown, key: string): number | null {
  if (!answers || typeof answers !== 'object' || !(key in answers)) return null;
  const answer = (answers as Record<string, unknown>)[key];
  if (!answer || typeof answer !== 'object' || !('score' in answer)) return null;
  return typeof answer.score === 'number' ? answer.score : null;
}

function riskStory(visit: NodeVisit, run: Partial<AgentRunItem> | undefined): NodeStory {
  if (completed(visit).skipped === true) return { summary: 'No risk records were available for this case.', details: [] };
  const decision = event(visit, 'DECISION_MADE')?.payload;
  const tier = completed(visit).tier ?? decision?.tier;
  const riskLevel = typeof tier === 'string' ? tier.toLowerCase() : 'recorded';
  const details: string[] = [];
  const signals: Array<[string, string]> = [
    ['velocity_abuse', 'repeated payment attempts'],
    ['identity_mismatch', 'account, device or card-location differences'],
    ['chargeback_pattern', 'past customer risk flags'],
    ['merchant_exposure', 'recent merchant disputes'],
  ];
  const elevated = signals.filter(([key]) => (score(decision?.answers, key) ?? 0) >= 2).map(([, label]) => label);
  if (elevated.length) details.push(`Strongest concerns: ${elevated.join('; ')}.`);
  const evidence = run?.evidence ?? [];
  const attempts = evidence.find((item) => item.source === 'getFailedAttempts')?.facts.failed24h;
  if (typeof attempts === 'number' && attempts > 0) details.push(`${attempts} failed payment attempts were recorded in the last 24 hours.`);
  const countries = evidence.find((item) => item.source === 'getDeviceSignals')?.facts.cardCountriesDistinct;
  if (typeof countries === 'number' && countries > 1) details.push(`Cards from ${countries} countries appeared in the device signals.`);
  if (completed(visit).fallback === true) details.push('The decision service was unavailable, so fixed rules supplied this risk rating.');
  else if (decision) details.push('Compared payment attempts, account and device details, customer flags, and merchant disputes.');
  details.push('This rating does not authorize a payment action. The policy checks that separately.');
  return { summary: typeof tier === 'string' ? `Rated this case as ${riskLevel} risk after reviewing the available signals.` : 'Reviewed payment and account risk signals.', details };
}

function findingsStory(visit: NodeVisit, run: Partial<AgentRunItem> | undefined, agent: 'payment' | 'reconciliation'): NodeStory {
  const findings = run?.findings?.filter((finding) => finding.agent === agent) ?? [];
  const createdIds = visit.steps.filter((step) => step.kind === 'FINDING_CREATED').flatMap((step) => Array.isArray(step.payload.findingIds) ? step.payload.findingIds : []);
  const matching = findings.filter((finding) => createdIds.includes(finding.id));
  if (completed(visit).skipped === true) return { summary: 'No relevant records were available for this specialist.', details: [] };
  if (matching.length) return {
    summary: matching[0]!.statement,
    details: matching.flatMap((finding, i) => i === 0 ? [`Supported by ${finding.evidenceIds.join(', ')}.`] : [finding.statement, `Supported by ${finding.evidenceIds.join(', ')}.`]),
  };
  const tools = visit.steps.filter((step) => step.kind === 'TOOL_COMPLETED').flatMap((step) => Array.isArray(step.payload.tools) ? step.payload.tools.filter((name): name is string => typeof name === 'string') : []);
  return {
    summary: agent === 'payment' ? 'Checked the payment and gateway records; no finding was recorded.' : 'Compared ledger, webhook and settlement records; no finding was recorded.',
    details: tools.length ? [`Records checked: ${[...new Set(tools)].join(', ')}.`] : [],
  };
}

function proposalStory(visit: NodeVisit): NodeStory {
  const proposal = event(visit, 'PROPOSAL_CREATED')?.payload.proposal;
  if (!proposal || typeof proposal !== 'object' || !('actions' in proposal) || !Array.isArray(proposal.actions)) return { summary: 'A resolution was considered, but no proposal was recorded.', details: [] };
  const actions = proposal.actions.flatMap((action: unknown) => {
    if (!action || typeof action !== 'object' || !('type' in action) || typeof action.type !== 'string' || !(action.type in ACTION_META)) return [];
    return [ACTION_META[action.type as keyof typeof ACTION_META].label];
  });
  return { summary: actions.length ? `Proposed: ${actions.join('; ')}.` : 'A proposal was recorded.', details: 'rationale' in proposal && typeof proposal.rationale === 'string' ? [proposal.rationale] : [] };
}

function policyStory(visit: NodeVisit): NodeStory {
  const decision = event(visit, 'POLICY_DECIDED')?.payload;
  const tier = decision?.tier;
  const summary = tier === 'AUTO' ? 'Policy allowed this action to run automatically.'
    : tier === 'OPS' ? 'Policy requires another operations analyst to approve before execution.'
    : tier === 'MANAGER' ? 'Policy requires a manager to approve before execution.'
    : tier === 'BLOCKED' ? 'Policy blocked the proposed action.'
    : 'Policy evaluated the proposed action.';
  const reasons = Array.isArray(decision?.reasons) ? decision.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
  return { summary, details: reasons };
}

function verificationStory(visit: NodeVisit): NodeStory {
  const validation = event(visit, 'VALIDATION_COMPLETED')?.payload.validation;
  if (!validation || typeof validation !== 'object' || !('verdict' in validation)) return { summary: 'The independent verification is checking the result.', details: [] };
  const verdict = validation.verdict;
  return { summary: verdict === 'PASS' ? 'Independent checks confirmed the fix worked.' : verdict === 'FAIL' ? 'Independent checks found that the fix did not work.' : 'Independent checks found that the result needs further review.', details: [] };
}

/** Short, factual copy for the operator view. Raw event names stay in the technical log. */
export function nodeStory(visit: NodeVisit, run?: Partial<AgentRunItem>): NodeStory {
  switch (visit.node) {
    case 'loadCase': return { summary: 'Loaded the current case and its payment records.', details: [] };
    case 'triage': return { summary: 'Collected the first records needed to understand the mismatch.', details: [] };
    case 'diagnose': return { summary: completed(visit).path === 'FAST' ? 'Matched a known issue pattern using the available records.' : 'Checked for a known issue pattern before a broader investigation.', details: [] };
    case 'plan': {
      const selected = completed(visit).specialists;
      const labels = { payment: 'payment records', reconciliation: 'ledger and settlement records', risk: 'risk signals' } as const;
      const names = Array.isArray(selected) ? selected.flatMap((name) => typeof name === 'string' && name in labels ? [labels[name as keyof typeof labels]] : []) : [];
      return { summary: names.length ? `Sent the case to specialists for ${names.join(', ')}.` : 'Chose which specialists should investigate the case.', details: [] };
    }
    case 'paymentAgent': return findingsStory(visit, run, 'payment');
    case 'reconciliationAgent': return findingsStory(visit, run, 'reconciliation');
    case 'riskAgent': return riskStory(visit, run);
    case 'join': return { summary: 'Combined the evidence and findings from the specialists that ran.', details: [] };
    case 'groundCheck': {
      const violations = completed(visit).violations;
      return { summary: 'Checked whether the findings are supported by cited records.', details: Array.isArray(violations) && violations.length ? [`${violations.length} finding(s) failed the evidence check.`] : [] };
    }
    case 'resolve': return proposalStory(visit);
    case 'policyGate': return policyStory(visit);
    case 'awaitApproval': return { summary: visit.state === 'WAITING' ? 'Waiting for an authorized colleague to review the proposal.' : event(visit, 'APPROVAL_RESOLVED') ? 'A colleague recorded an approval decision.' : 'The run paused for human approval.', details: [] };
    case 'execute': return { summary: visit.state === 'COMPLETED' ? 'The deterministic executor applied the permitted action.' : 'Execution of the permitted action is in progress or stopped.', details: [] };
    case 'validate': return verificationStory(visit);
    case 'replan': return { summary: 'The previous result did not pass verification, so the run considered another approach.', details: [] };
    case 'closeResolved': return { summary: 'The case was closed after a verified resolution.', details: [] };
    case 'closeBlocked': return { summary: 'The case stopped because policy blocked the action.', details: [] };
    case 'closeRejected': return { summary: 'The case stopped after the proposal was rejected.', details: [] };
    case 'closeEscalated': return { summary: 'The case was escalated for human review.', details: [] };
    default: return { summary: 'This recorded step has no plain-language description yet. Open the technical events for details.', details: [] };
  }
}
