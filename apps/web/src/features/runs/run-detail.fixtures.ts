/** Shared fixtures for run detail tests (D060 follow-up). */
import type { AgentRunItem, AgentStepItem } from '@payops/shared';

let seq = 0;
let clock = Date.parse('2026-09-29T15:00:00.000Z');
export function ev(node: string, kind: AgentStepItem['kind'], payload: Record<string, unknown> = {}): AgentStepItem {
  seq += 1;
  clock += 1000;
  return { id: `s${seq}`, runId: 'run_1', seq, node, kind, payload, at: new Date(clock).toISOString() };
}

export const evidence = [
  { id: 'ev_01', source: 'getGatewayPayment', system: 'GATEWAY', entityRef: 'gw_pay_1', facts: { status: 'CAPTURED', amountMinor: 1249900 }, observedAt: '2026-09-29T15:00:01Z', stepId: 'triage' },
  { id: 'ev_02', source: 'getWebhookDeliveries', system: 'WEBHOOK', entityRef: 'whd_1', facts: { attempts: 3 }, observedAt: '2026-09-29T15:00:01Z', stepId: 'triage' },
  { id: 'ev_03', source: 'getOrderTimeline', system: 'ORDER', entityRef: 'ord_1', facts: { status: 'FAILED' }, observedAt: '2026-09-29T15:00:05Z', stepId: 'paymentAgent' },
];

export function run(over: Partial<AgentRunItem> = {}): AgentRunItem {
  return {
    id: 'run_1', caseId: 'case_1', resolutionId: 'res_1', status: 'RESOLVED', path: 'FULL', attempt: 1, evidence,
    findings: [{ id: 'fd_01', agent: 'payment', code: 'WEBHOOK_HTTP_500', statement: 'The webhook failed 3 times.', evidenceIds: ['ev_02'], confidence: 0.9 }],
    grounding: { checked: 1, violations: [], sufficient: true },
    proposal: { actions: [{ type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: 'e1' } }], rationale: 'Replay it', expectedPostconditions: ['Order becomes PAID'] },
    ...over,
  } as unknown as AgentRunItem;
}

export const fullRun: AgentStepItem[] = [
  ev('loadCase', 'NODE_STARTED'), ev('loadCase', 'NODE_COMPLETED'),
  ev('triage', 'NODE_STARTED'), ev('triage', 'TOOL_COMPLETED', { tools: ['getGatewayPayment', 'getWebhookDeliveries'], evidenceIds: ['ev_01', 'ev_02'] }), ev('triage', 'NODE_COMPLETED'),
  ev('diagnose', 'NODE_STARTED'),
  ev('diagnose', 'DECISION_MADE', { tag: 'J6_DIAGNOSE', answers: {
    root_cause: { type: 'choice', choice: 'webhook_or_state_sync', confidence: 0.71 },
    needs_human: { type: 'noul', noul: 0.2 }, evidence_consistent: { type: 'noul', noul: 0.9 } } }),
  ev('diagnose', 'NODE_COMPLETED', { path: 'FULL', rootCause: 'webhook_or_state_sync', confidence: 0.71 }),
  ev('plan', 'NODE_STARTED'), ev('plan', 'DECISION_MADE', { tag: 'J2_PLAN', answers: {} }),
  ev('plan', 'NODE_COMPLETED', { specialists: ['payment', 'reconciliation', 'risk'], routedBy: 'JEV', primaryHypothesis: 'webhook_or_state_sync' }),
  ev('paymentAgent', 'NODE_STARTED'),
  ev('paymentAgent', 'LLM_CALLED', { call: 'followUps', followUps: [
    { tool: 'getOrderTimeline', reason: 'See why the order is FAILED.' }, { tool: 'getPaymentAttempts', reason: 'Look for retries.' }], contextTokenEstimate: 900 }),
  ev('paymentAgent', 'TOOL_COMPLETED', { tools: ['getOrderTimeline'], evidenceIds: ['ev_03'] }),
  ev('paymentAgent', 'LLM_CALLED', { call: 'findings', contextTokenEstimate: 1400 }),
  ev('paymentAgent', 'FINDING_CREATED', { findingIds: ['fd_01'] }),
  ev('paymentAgent', 'NODE_COMPLETED', { evidenceCount: 3, findingCount: 1 }),
  ev('reconciliationAgent', 'NODE_STARTED'), ev('reconciliationAgent', 'NODE_COMPLETED', { skipped: true }),
  ev('join', 'NODE_STARTED'), ev('join', 'NODE_COMPLETED', {}),
  ev('groundCheck', 'NODE_STARTED'), ev('groundCheck', 'DECISION_MADE', { tag: 'J4_GROUND', answers: {} }), ev('groundCheck', 'NODE_COMPLETED', { violations: [], sufficient: true, gaps: [] }),
  ev('resolve', 'NODE_STARTED'), ev('resolve', 'PROPOSAL_CREATED', { proposal: { actions: [{ type: 'REPLAY_WEBHOOK_EVENT', params: {} }], rationale: 'Replay it', expectedPostconditions: ['Order becomes PAID'] } }), ev('resolve', 'NODE_COMPLETED', {}),
  ev('policyGate', 'NODE_STARTED'), ev('policyGate', 'POLICY_DECIDED', { tier: 'AUTO', reasons: ['State corrections only'] }), ev('policyGate', 'NODE_COMPLETED', { tier: 'AUTO' }),
  ev('execute', 'NODE_STARTED'), ev('execute', 'EXECUTION_STEP', {}), ev('execute', 'NODE_COMPLETED', {}),
  ev('validate', 'NODE_STARTED'), ev('validate', 'VALIDATION_COMPLETED', { validation: { verdict: 'PASS', checks: [{ pass: true }] } }), ev('validate', 'NODE_COMPLETED', {}),
  ev('closeResolved', 'NODE_STARTED'), ev('closeResolved', 'RUN_COMPLETED', { status: 'RESOLVED' }),
];

