/** Shared fixtures for the case story tests (D060). */
import type { AgentRunItem, AgentStepItem, CaseDetail, CaseSourceRecords, ResolutionItem } from '@payops/shared';

export const at = '2026-09-29T12:32:00.000Z';
let seq = 0;
export function step(node: string, kind: AgentStepItem['kind'], payload: Record<string, unknown> = {}): AgentStepItem {
  seq += 1;
  return { id: `s${seq}`, runId: 'run_1', seq, node, kind, payload, at };
}

export const caseDetail = {
  id: 'case_1', displayId: 'PAY-8291', status: 'RESOLVED', amountMinor: 499900, ruleIds: ['D1_CAPTURED_NOT_PAID'],
  mismatched: ['ORDER', 'LEDGER'], openedAt: at, lifecycle: [], resolution: { by: 'AGENT', summary: 'Replayed webhook' },
  resolutionView: { resolutions: [] as ResolutionItem[] },
} as unknown as CaseDetail;

export const evidence = [
  { id: 'ev_01', source: 'getGatewayPayment', system: 'GATEWAY', entityRef: 'gw_pay_1', facts: { status: 'CAPTURED', amountMinor: 499900 }, observedAt: at, stepId: 'triage' },
  { id: 'ev_02', source: 'getWebhookDeliveries', system: 'WEBHOOK', entityRef: 'whd_1', facts: { attempts: 3 }, observedAt: at, stepId: 'triage' },
];

export function run(over: Partial<AgentRunItem> = {}): AgentRunItem {
  return {
    id: 'run_1', caseId: 'case_1', resolutionId: 'res_1', status: 'RESOLVED', path: 'FULL', attempt: 1,
    evidence, findings: [
      { id: 'fd_01', agent: 'payment', code: 'WEBHOOK_HTTP_500', statement: 'The webhook failed three times.', evidenceIds: ['ev_02'], confidence: 0.9 },
      { id: 'fd_02', agent: 'payment', code: 'OTHER', statement: 'Unrelated claim.', evidenceIds: ['ev_01'], confidence: 0.4 },
    ],
    grounding: { checked: 2, violations: [{ findingId: 'fd_02', reason: 'Evidence does not mention this.' }], sufficient: true },
    proposal: { actions: [], rationale: 'Replay it', expectedPostconditions: ['Order becomes PAID'] },
    ...over,
  } as unknown as AgentRunItem;
}

export const steps: AgentStepItem[] = [
  step('triage', 'NODE_STARTED'),
  step('triage', 'TOOL_COMPLETED', { tools: ['getGatewayPayment'], evidenceIds: ['ev_01', 'ev_02'] }),
  step('triage', 'NODE_COMPLETED'),
  step('plan', 'NODE_STARTED'),
  step('plan', 'DECISION_MADE', { tag: 'J2_PLAN', answers: {} }),
  step('plan', 'NODE_COMPLETED', { specialists: ['payment'], primaryHypothesis: 'webhook_or_state_sync' }),
  step('paymentAgent', 'NODE_STARTED'),
  step('paymentAgent', 'LLM_CALLED', { call: 'findings' }),
  step('paymentAgent', 'MODEL_RETRY', { provider: 'gemini', reason: 'timeout', attempt: 2 }),
  step('paymentAgent', 'FINDING_CREATED', { findingIds: ['fd_01', 'fd_02'] }),
  step('paymentAgent', 'NODE_COMPLETED'),
  step('groundCheck', 'NODE_STARTED'),
  step('groundCheck', 'DECISION_MADE', { tag: 'J4_GROUND', answers: {} }),
  step('groundCheck', 'NODE_COMPLETED', { violations: [] }),
];

export function resolution(over: Partial<ResolutionItem> = {}): ResolutionItem {
  return {
    id: 'res_1', caseId: 'case_1', runId: 'run_1', attempt: 1, status: 'VALIDATED',
    actions: [{ type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: 'evt_1' } }],
    rationale: 'Replay the missed webhook.', proposedBy: { type: 'AGENT', id: 'agt', name: 'Investigation' },
    policy: { tier: 'AUTO', reasons: [{ ruleId: 'P6', tier: 'AUTO', reason: 'State correction only' }], version: '1', moneyMovingMinor: 0, riskTier: 'LOW' },
    approval: null,
    executions: [{
      index: 0, type: 'REPLAY_WEBHOOK_EVENT', status: 'SUCCEEDED', idempotencyKey: 'k', summary: 'Replayed, HTTP 200', error: null,
      before: [
        { system: 'ORDER', kind: 'Order', id: 'ord_1', status: 'FAILED', amountMinor: 499900 },
        { system: 'WEBHOOK', kind: 'Webhook delivery', id: 'whd_1', status: 'FAILED', amountMinor: null },
      ],
      startedAt: at, finishedAt: at,
    }],
    validation: { id: 'val_1', verdict: 'PASS', at, checks: [{ id: 'a0.order', subject: 'order.status', description: 'Order is paid', expected: 'PAID', actual: 'PAID', pass: true, kind: 'POSTCONDITION', actionIndex: 0 }] },
    createdAt: at, updatedAt: at,
    ...over,
  } as unknown as ResolutionItem;
}

export const records: CaseSourceRecords = {
  caseId: 'case_1', readAt: at,
  records: [
    { system: 'ORDER', kind: 'Order', id: 'ord_1', status: 'PAID', amountMinor: 499900, at, details: [] },
    { system: 'WEBHOOK', kind: 'Webhook delivery', id: 'whd_1', status: 'FAILED', amountMinor: null, at, details: [] },
    { system: 'LEDGER', kind: 'Ledger entry', id: 'led_1', status: 'CREDIT cash', amountMinor: 499900, at, details: [] },
  ],
};

