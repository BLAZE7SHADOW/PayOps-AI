/**
 * DEV-ONLY stand-in for Phase 2 core: demo users, action options, a small policy engine,
 * execution and validation. It mirrors the contract in packages/shared (dto/resolution.ts) so the
 * UI can be built and screenshotted without the server. The real rules live in packages/core.
 */
import {
  ACTION_META,
  CRITICAL_RISK_ALLOWED,
  HOUR_MS,
  MINUTE_MS,
  POLICY_RULES,
  POLICY_TIER_RANK,
  POLICY_VERSION,
  formatMoney,
  moneyMovingMinor,
  seededIds,
  type ActionOption,
  type ActorRef,
  type ApprovalItem,
  type CaseDetail,
  type CaseResolutionView,
  type CatalogAction,
  type DemoAccount,
  type ExecutionStep,
  type PolicyDecision,
  type PolicyDocument,
  type PolicyPreview,
  type PolicyReason,
  type PolicyTier,
  type PreconditionFailure,
  type ResolutionItem,
  type RiskTier,
  type SessionUser,
  type ValidationCheck,
} from '@payops/shared';
import { after, ago, caseFromPayment, type MockDb, type StoredApproval } from './fixtures';

const ids = seededIds('payops-web-mock-resolution');
const S = 1000;

// ── Users ────────────────────────────────────────────────────────────────────
export const MOCK_PASSWORD = 'payops-demo';

export const USERS: Array<SessionUser & { label: string }> = [
  { id: 'usr_ananya', email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS', label: 'Ops analyst' },
  { id: 'usr_rahul', email: 'ops2@payops.dev', name: 'Rahul Menon', role: 'OPS', label: 'Ops analyst' },
  { id: 'usr_meera', email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER', label: 'Ops manager' },
  { id: 'usr_kabir', email: 'viewer@payops.dev', name: 'Kabir Shah', role: 'VIEWER', label: 'Viewer' },
  { id: 'usr_admin', email: 'admin@payops.dev', name: 'Admin', role: 'ADMIN', label: 'Admin' },
];

export const demoAccounts = (): DemoAccount[] => USERS.map(({ email, name, role, label }) => ({ email, name, role, label }));
export const toSession = ({ id, email, name, role }: SessionUser): SessionUser => ({ id, email, name, role });
const actor = (u: SessionUser): ActorRef => ({ type: 'USER', id: u.id, name: u.name });
const user = (id: string) => USERS.find((u) => u.id === id)!;

// ── Action options ───────────────────────────────────────────────────────────
function refs(c: CaseDetail) {
  const tail = c.id.slice(-12);
  return {
    paymentId: c.entityRefs.paymentId ?? '',
    gwPaymentId: c.entityRefs.gwPaymentId ?? '',
    orderId: c.entityRefs.orderId ?? '',
    batchId: c.entityRefs.batchId ?? '',
    eventId: `evt_${tail}`,
    refundId: c.entityRefs.refundId ?? `rfd_${tail}`,
    journalId: `jrn_${tail}`,
  };
}

type OptionSpec = Omit<ActionOption, 'type'>;
const unavailable = (action: CatalogAction, reason: string): OptionSpec => ({
  action,
  summary: ACTION_META[action.type].description,
  recommended: false,
  available: false,
  unavailableReason: reason,
  editable: [],
  maxAmountMinor: null,
});

export function actionOptions(db: MockDb, c: CaseDetail): ActionOption[] {
  const tag = db.caseMeta[c.id]?.tag ?? '';
  const r = refs(c);
  const m = c.matrix.cells;
  const captured = (m.GATEWAY.status ?? '').startsWith('CAPTURED');
  const payment = Boolean(r.paymentId);
  const amount = c.amountMinor;
  const opts: OptionSpec[] = [];

  const replay: CatalogAction = { type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: r.eventId } };
  const webhookFailed = c.matrix.cells.WEBHOOK.mismatch;
  opts.push(
    webhookFailed
      ? {
          action: replay,
          summary: `Replay ${tag === 'refund_stuck' ? 'refund.processed' : 'payment.captured'} (${r.eventId}) to our webhook consumer`,
          recommended: tag === 'captured_order_failed' || tag === 'injected_refund_request',
          available: true,
          unavailableReason: null,
          editable: [],
          maxAmountMinor: null,
        }
      : unavailable(replay, 'Every webhook for this payment was delivered.'),
  );

  const markPaid: CatalogAction = { type: 'MARK_ORDER_PAID', params: { orderId: r.orderId || 'ord_none', paymentId: r.paymentId || 'pay_none' } };
  const orderStatus = m.ORDER.status ?? '';
  opts.push(
    captured && (orderStatus === 'FAILED' || orderStatus === 'PENDING')
      ? { action: markPaid, summary: `Move order ${r.orderId} from ${orderStatus} to PAID and link ${r.paymentId}`, recommended: false, available: true, unavailableReason: null, editable: [], maxAmountMinor: null }
      : unavailable(markPaid, orderStatus === 'CANCELLED' ? 'Order is CANCELLED. A cancelled order cannot be marked paid.' : payment ? `Order is already ${orderStatus || 'settled'}.` : 'No single order on this case.'),
  );

  const post: CatalogAction = { type: 'POST_LEDGER_ENTRY', params: { paymentId: r.paymentId || 'pay_none', amountMinor: amount } };
  opts.push(
    m.LEDGER.status === 'MISSING'
      ? { action: post, summary: `Post the ${formatMoney(amount)} capture journal for ${r.paymentId}`, recommended: tag === 'captured_order_failed' || tag === 'injected_refund_request', available: true, unavailableReason: null, editable: [], maxAmountMinor: null }
      : unavailable(post, 'Ledger already has the capture journal.'),
  );

  opts.push(unavailable({ type: 'REVERSE_LEDGER_ENTRY', params: { journalId: r.journalId } }, 'No wrong or duplicate journal to reverse.'));

  const refundReason = tag === 'refund_never_initiated' ? 'Order cancelled by merchant: out of stock' : tag === 'duplicate_capture' ? 'Duplicate capture for one order' : 'Customer charged for a failed order';
  const refund: CatalogAction = { type: 'INITIATE_REFUND', params: { gwPaymentId: r.gwPaymentId || 'gwp_none', amountMinor: amount, reason: refundReason } };
  opts.push(
    captured && payment
      ? {
          action: refund,
          summary: `Refund up to ${formatMoney(amount)} on ${r.gwPaymentId} to the original payment method`,
          recommended: tag === 'refund_never_initiated' || tag === 'duplicate_capture',
          available: true,
          unavailableReason: null,
          editable: ['amountMinor', 'reason'],
          maxAmountMinor: amount,
        }
      : unavailable(refund, m.GATEWAY.status === 'REFUNDED' ? 'The gateway already refunded this payment.' : 'No captured payment to refund.'),
  );

  const sync: CatalogAction = { type: 'SYNC_REFUND_STATUS', params: { refundId: r.refundId } };
  opts.push(
    tag === 'refund_stuck'
      ? { action: sync, summary: `Copy gateway status PROCESSED to refund ${r.refundId} and post the refund journal`, recommended: true, available: true, unavailableReason: null, editable: [], maxAmountMinor: null }
      : unavailable(sync, 'No refund exists for this payment.'),
  );

  const dispute: CatalogAction = { type: 'RAISE_SETTLEMENT_DISPUTE', params: { batchId: r.batchId || 'stb_none', amountMinor: 236_85 } };
  opts.push(
    c.type === 'SETTLEMENT_MISMATCH'
      ? { action: dispute, summary: `Dispute the ₹236.85 shortfall on batch ${r.batchId}: fee charged at 2.2% against a 2.0% contract`, recommended: true, available: true, unavailableReason: null, editable: [], maxAmountMinor: null }
      : unavailable(dispute, 'Settlement matched for this payment.'),
  );

  const hold: CatalogAction = { type: 'HOLD_PAYMENT_FOR_REVIEW', params: { paymentId: r.paymentId || 'pay_none' } };
  opts.push(
    payment
      ? { action: hold, summary: `Exclude ${r.paymentId} from payouts until someone reviews it`, recommended: tag === 'suspicious_payment', available: true, unavailableReason: null, editable: [], maxAmountMinor: null }
      : unavailable(hold, 'No single payment to hold on a settlement case.'),
  );

  opts.push({
    action: { type: 'ESCALATE_TO_HUMAN', params: { reason: tag === 'suspicious_payment' ? 'Velocity pattern needs a risk review' : 'Needs review by a manager', to: 'MANAGER' } },
    summary: 'Assign the case to a manager with the reason attached',
    recommended: tag === 'suspicious_payment',
    available: true,
    unavailableReason: null,
    editable: ['reason'],
    maxAmountMinor: null,
  });

  return opts.map((o) => ({ ...o, type: o.action.type }));
}

// ── Policy (mirrors POLICY_RULES for proposals from people) ──────────────────
function reason(ruleId: PolicyReason['ruleId'], tier: PolicyTier, text: string): PolicyReason {
  return { ruleId, tier, reason: text };
}

function preconditions(db: MockDb, c: CaseDetail, actions: CatalogAction[]): PreconditionFailure[] {
  const options = actionOptions(db, c);
  const out: PreconditionFailure[] = [];
  actions.forEach((a, i) => {
    const o = options.find((x) => x.type === a.type);
    if (!o?.available) out.push({ actionIndex: i, type: a.type, message: o?.unavailableReason ?? 'Not allowed for this case.' });
    else if (a.type === 'INITIATE_REFUND' && o.maxAmountMinor !== null && a.params.amountMinor > o.maxAmountMinor)
      out.push({ actionIndex: i, type: a.type, message: `Amount is more than the refundable ${formatMoney(o.maxAmountMinor)}.` });
  });
  return out;
}

export function evaluate(db: MockDb, c: CaseDetail, actions: CatalogAction[], attempt: number): PolicyPreview {
  const risk: RiskTier = db.caseMeta[c.id]?.risk ?? 'LOW';
  const failures = preconditions(db, c, actions);
  const money = moneyMovingMinor(actions);
  const classes = actions.map((a) => ACTION_META[a.type].actionClass);
  const reasons: PolicyReason[] = [];

  if (actions.length === 0 || failures.length) reasons.push(reason('P0', 'BLOCKED', `${failures.length} precondition ${failures.length === 1 ? 'check fails' : 'checks fail'}`));
  if (risk === 'CRITICAL' && actions.some((a) => !CRITICAL_RISK_ALLOWED.includes(a.type))) reasons.push(reason('P1', 'BLOCKED', 'Risk is CRITICAL; only hold or escalate may run'));
  if (risk === 'HIGH' || risk === 'CRITICAL') reasons.push(reason('P2', 'MANAGER', `Risk is ${risk}`));
  if (money > 10_000_00) reasons.push(reason('P3', 'MANAGER', `Refund of ${formatMoney(money)} is over ₹10,000.00`));
  else if (money > 1_000_00) reasons.push(reason('P4', 'OPS', `Refund of ${formatMoney(money)} is between ₹1,000.00 and ₹10,000.00`));
  else if (money > 0 && risk === 'LOW') reasons.push(reason('P5', 'AUTO', `Refund of ${formatMoney(money)} with LOW risk`));
  if (classes.length && classes.every((k) => k === 'STATE_CORRECTION')) reasons.push(reason('P6', 'AUTO', 'State corrections only; gateway shows the capture'));
  if (attempt >= 2) reasons.push(reason('P7', 'OPS', `Attempt ${attempt} on this case`));
  if (classes.includes('CLAIM')) reasons.push(reason('P9', 'OPS', 'Raises a claim with the acquirer'));
  if (classes.length && classes.every((k) => k === 'CONTROL')) reasons.push(reason('P10', 'AUTO', 'Hold or escalate only'));

  const tier = reasons.reduce<PolicyTier>((t, r) => (POLICY_TIER_RANK[r.tier] > POLICY_TIER_RANK[t] ? r.tier : t), reasons.length ? 'AUTO' : 'OPS');
  const decision: PolicyDecision = { tier, reasons, version: POLICY_VERSION, moneyMovingMinor: money, riskTier: risk };
  const approverHint =
    tier === 'OPS' ? 'Needs approval from another Ops user or a manager.' : tier === 'MANAGER' ? 'Needs approval from a manager.' : null;
  return { decision, preconditionFailures: failures, approverHint, attempt };
}

// ── Execution and validation ─────────────────────────────────────────────────
function executionSummary(c: CaseDetail, a: CatalogAction): string {
  const r = refs(c);
  switch (a.type) {
    case 'REPLAY_WEBHOOK_EVENT':
      return `Gateway re-delivered ${a.params.eventId}; consumer answered HTTP 200 and moved the order to PAID`;
    case 'MARK_ORDER_PAID':
      return `Order ${a.params.orderId} moved to PAID and linked to ${a.params.paymentId}`;
    case 'POST_LEDGER_ENTRY':
      return `Posted ${r.journalId}: CUSTOMER_RECEIVABLE debit and MERCHANT_PAYABLE credit of ${formatMoney(a.params.amountMinor)}`;
    case 'REVERSE_LEDGER_ENTRY':
      return `Posted the reversal of ${a.params.journalId}`;
    case 'INITIATE_REFUND':
      return `Gateway accepted refund gwr_${c.id.slice(-10)} for ${formatMoney(a.params.amountMinor)}, status PENDING`;
    case 'SYNC_REFUND_STATUS':
      return `Refund ${a.params.refundId} PENDING to PROCESSED; refund journal posted`;
    case 'RAISE_SETTLEMENT_DISPUTE':
      return `Opened dispute dsp_${c.id.slice(-10)} for ${formatMoney(a.params.amountMinor)} on ${a.params.batchId}`;
    case 'HOLD_PAYMENT_FOR_REVIEW':
      return `Payment ${a.params.paymentId} held and excluded from the next payout`;
    case 'ESCALATE_TO_HUMAN':
      return `Assigned to ${user('usr_meera').name} with the reason attached`;
  }
}

const check = (subject: string, description: string, expected: string, actual: string, kind: ValidationCheck['kind'], actionIndex: number | null): ValidationCheck => ({
  id: ids.next('execution').replace('exe_', 'chk_'),
  subject,
  description,
  expected,
  actual,
  // Live mock executions always succeed; the seeded FAIL attempt spells its checks out by hand.
  pass: true,
  kind,
  actionIndex,
});

function postconditions(c: CaseDetail, a: CatalogAction, i: number): ValidationCheck[] {
  const r = refs(c);
  switch (a.type) {
    case 'REPLAY_WEBHOOK_EVENT':
      return [
        check(`webhook.${a.params.eventId}.delivery`, 'Latest delivery status', '2xx', 'HTTP 200', 'POSTCONDITION', i),
        check('payment.internalStatus', 'Internal payment state equals gateway state', 'CAPTURED', 'CAPTURED', 'POSTCONDITION', i),
      ];
    case 'MARK_ORDER_PAID':
      return [
        check(`order.${a.params.orderId}.status`, 'Order status', 'PAID', 'PAID', 'POSTCONDITION', i),
        check(`order.${a.params.orderId}.paymentId`, 'Order links the captured payment', a.params.paymentId, a.params.paymentId, 'POSTCONDITION', i),
      ];
    case 'POST_LEDGER_ENTRY':
      return [check(`ledger.credits(${a.params.paymentId})`, 'Exactly one capture credit, amount equal', `1 · ${formatMoney(a.params.amountMinor)}`, `1 · ${formatMoney(a.params.amountMinor)}`, 'POSTCONDITION', i)];
    case 'REVERSE_LEDGER_ENTRY':
      return [check(`ledger.net(${r.paymentId})`, 'Net ledger matches expected', formatMoney(c.amountMinor), formatMoney(c.amountMinor), 'POSTCONDITION', i)];
    case 'INITIATE_REFUND':
      return [
        check(`gateway.refunds(${a.params.gwPaymentId}).status`, 'Refund exists at the gateway', 'PENDING or PROCESSED', 'PENDING', 'POSTCONDITION', i),
        check(`gateway.refunds(${a.params.gwPaymentId}).amount`, 'Refund within captured minus refunded', `≤ ${formatMoney(c.amountMinor)}`, formatMoney(a.params.amountMinor), 'POSTCONDITION', i),
      ];
    case 'SYNC_REFUND_STATUS':
      return [check(`refund.${a.params.refundId}.status`, 'Internal refund status equals gateway', 'PROCESSED', 'PROCESSED', 'POSTCONDITION', i)];
    case 'RAISE_SETTLEMENT_DISPUTE':
      return [check(`dispute(${a.params.batchId}).amount`, 'Dispute record with the difference', formatMoney(a.params.amountMinor), formatMoney(a.params.amountMinor), 'POSTCONDITION', i)];
    case 'HOLD_PAYMENT_FOR_REVIEW':
      return [check(`payment.${a.params.paymentId}.hold`, 'Payment is held', 'true', 'true', 'POSTCONDITION', i)];
    case 'ESCALATE_TO_HUMAN':
      return [check('case.assignee', 'Case is assigned to a person', 'set', user('usr_meera').name, 'POSTCONDITION', i)];
  }
}

function invariants(c: CaseDetail): ValidationCheck[] {
  const amt = formatMoney(c.amountMinor);
  if (c.type === 'SETTLEMENT_MISMATCH') {
    return [check('settlement.net = ledger.net', 'Settled gross minus fees equals ledger net, after the open dispute', '₹1,16,056.50', '₹1,16,056.50', 'INVARIANT', null)];
  }
  if (c.type === 'REFUND_EXCEPTION') {
    return [
      check('Σ refunds.internal = Σ refunds.gateway', 'Internal and gateway refund totals agree', amt, amt, 'INVARIANT', null),
      check('refunds.pendingBeyondSla', 'No refund pending beyond the 5 day SLA', '0', '0', 'INVARIANT', null),
    ];
  }
  return [
    check('order.status | gateway CAPTURED', 'A captured payment has a PAID order', 'PAID', 'PAID', 'INVARIANT', null),
    check('ledger.credits = captured', 'Exactly one ledger credit equal to the captured amount', `1 · ${amt}`, `1 · ${amt}`, 'INVARIANT', null),
  ];
}

/** Runs the proposal against the mock case: every step succeeds and the validator passes. */
export function execute(db: MockDb, c: CaseDetail, res: ResolutionItem, now = Date.now()): void {
  let t = now;
  res.executions = res.actions.map((a, index): ExecutionStep => {
    const startedAt = new Date(t).toISOString();
    t += 180 + index * 140;
    return {
      index,
      type: a.type,
      status: 'SUCCEEDED',
      idempotencyKey: `idem_${res.id.slice(-8)}_${index}`,
      summary: executionSummary(c, a),
      error: null,
      startedAt,
      finishedAt: new Date(t).toISOString(),
    };
  });
  const checks = [...res.actions.flatMap((a, i) => postconditions(c, a, i)), ...invariants(c)];
  res.validation = { id: ids.next('execution').replace('exe_', 'val_'), verdict: checks.every((x) => x.pass) ? 'PASS' : 'FAIL', checks, at: new Date(t + 300).toISOString() };
  res.status = 'VALIDATED';
  res.updatedAt = res.validation.at;
  applyFix(c, res);
}

/** After a PASS the systems agree again: clear the mismatches and close the case. */
function applyFix(c: CaseDetail, res: ResolutionItem): void {
  if (res.validation?.verdict !== 'PASS') return;
  const controlOnly = res.actions.every((a) => ACTION_META[a.type].actionClass === 'CONTROL');
  if (controlOnly) {
    c.status = 'ESCALATED';
    c.assignee = { id: 'usr_meera', name: user('usr_meera').name };
    return;
  }
  const cells = c.matrix.cells;
  for (const k of Object.keys(cells) as Array<keyof typeof cells>) cells[k] = { ...cells[k], mismatch: false };
  if (cells.ORDER.status === 'FAILED' || cells.ORDER.status === 'PENDING') cells.ORDER = { ...cells.ORDER, status: 'PAID', detail: 'Marked PAID by resolution' };
  if (cells.LEDGER.status === 'MISSING' || cells.LEDGER.status === 'NO REFUND ENTRY') cells.LEDGER = { ...cells.LEDGER, status: 'POSTED', amountMinor: c.amountMinor, detail: 'Posted by resolution' };
  if (cells.WEBHOOK.status?.startsWith('HTTP 5') || cells.WEBHOOK.status?.startsWith('HTTP 4')) cells.WEBHOOK = { ...cells.WEBHOOK, status: 'HTTP 200', detail: 'Replayed' };
  c.matrix.mismatched = [];
  c.mismatched = [];
  c.status = 'RESOLVED';
  c.resolvedAt = res.updatedAt;
  c.resolution = { by: 'USER', summary: `Resolved manually: ${res.actions.map((a) => ACTION_META[a.type].label.toLowerCase()).join(', ')}. Validator PASS.` };
  c.updatedAt = res.updatedAt;
}

// ── Proposals and approvals ──────────────────────────────────────────────────
export function actionsSummaryOf(actions: CatalogAction[]): string {
  return actions
    .map((a) => (a.type === 'INITIATE_REFUND' || a.type === 'RAISE_SETTLEMENT_DISPUTE' ? `${ACTION_META[a.type].label} ${formatMoney(a.params.amountMinor)}` : ACTION_META[a.type].label))
    .join(' · ');
}

export function propose(db: MockDb, c: CaseDetail, by: SessionUser, actions: CatalogAction[], rationale: string): { resolution: ResolutionItem; approval: StoredApproval | null } {
  const attempt = db.resolutions.filter((r) => r.caseId === c.id).length + 1;
  const { decision } = evaluate(db, c, actions, attempt);
  const now = new Date().toISOString();
  const res: ResolutionItem = {
    id: ids.next('execution').replace('exe_', 'res_'),
    caseId: c.id,
    runId: null,
    attempt,
    status: decision.tier === 'BLOCKED' ? 'BLOCKED' : decision.tier === 'AUTO' ? 'EXECUTING' : 'AWAITING_APPROVAL',
    actions,
    rationale,
    proposedBy: actor(by),
    policy: decision,
    approval: null,
    executions: [],
    validation: null,
    createdAt: now,
    updatedAt: now,
  };
  db.resolutions.push(res);
  let approval: StoredApproval | null = null;
  if (res.status === 'AWAITING_APPROVAL') {
    approval = newApproval(db, c, res, now);
    c.status = 'AWAITING_APPROVAL';
  } else if (res.status === 'EXECUTING') {
    c.status = 'EXECUTING';
  }
  c.updatedAt = now;
  return { resolution: res, approval };
}

function newApproval(db: MockDb, c: CaseDetail, res: ResolutionItem, at: string): StoredApproval {
  const tier = res.policy.tier as StoredApproval['tier'];
  const a: StoredApproval = {
    id: ids.next('approval'),
    case: { id: c.id, displayId: c.displayId, type: c.type, status: c.status, amountMinor: c.amountMinor },
    resolutionId: res.id,
    tier,
    status: 'PENDING',
    actionsSummary: actionsSummaryOf(res.actions),
    actionTypes: res.actions.map((x) => x.type),
    moneyMovingMinor: res.policy.moneyMovingMinor,
    riskTier: res.policy.riskTier,
    ruleIds: [...new Set(res.policy.reasons.map((r) => r.ruleId))],
    requestedBy: res.proposedBy,
    requestedAt: at,
    decidedBy: null,
    decidedAt: null,
    comment: null,
  };
  res.approval = { id: a.id, tier, status: 'PENDING', decidedBy: null, comment: null, decidedAt: null };
  db.approvals.push(a);
  return a;
}

export function viewerApproval(db: MockDb, a: StoredApproval, viewer: SessionUser): ApprovalItem {
  const c = db.cases.find((x) => x.id === a.case.id);
  let reasonText: string | null = null;
  if (a.status !== 'PENDING') reasonText = `Already ${a.status.toLowerCase()}.`;
  else if (viewer.role === 'VIEWER') reasonText = 'Viewers cannot decide approvals.';
  else if (a.requestedBy.id === viewer.id) reasonText = 'You requested this. Another person must approve it.';
  else if (a.tier === 'MANAGER' && viewer.role !== 'MANAGER' && viewer.role !== 'ADMIN') reasonText = 'Needs a manager. MANAGER tier approvals need the MANAGER role.';
  return {
    ...a,
    case: c ? { id: c.id, displayId: c.displayId, type: c.type, status: c.status, amountMinor: c.amountMinor } : a.case,
    canDecide: reasonText === null,
    cannotDecideReason: reasonText,
  };
}

export function resolutionView(db: MockDb, c: CaseDetail, viewer: SessionUser): CaseResolutionView {
  const resolutions = db.resolutions.filter((r) => r.caseId === c.id);
  const pending = db.approvals.find((a) => a.case.id === c.id && a.status === 'PENDING');
  let reasonText: string | null = null;
  if (viewer.role === 'VIEWER') reasonText = 'Viewers cannot propose resolutions.';
  else if (pending) reasonText = 'A proposal on this case is waiting for approval.';
  else if (c.status === 'EXECUTING') reasonText = 'A resolution is executing.';
  else if (c.status === 'RESOLVED') reasonText = 'Resolved and verified. Nothing to propose.';
  return {
    actionOptions: actionOptions(db, c),
    resolutions,
    pendingApprovalId: pending?.id ?? null,
    canPropose: reasonText === null,
    cannotProposeReason: reasonText,
  };
}

export function policyDocument(): PolicyDocument {
  return {
    version: POLICY_VERSION,
    rules: POLICY_RULES,
    thresholds: [
      { label: 'Refund that runs without approval (LOW risk)', value: 'up to ₹1,000.00' },
      { label: 'Refund an Ops user can approve', value: '₹1,000.01 to ₹10,000.00' },
      { label: 'Refund that needs a manager', value: 'over ₹10,000.00' },
      { label: 'Agent confidence for an automatic refund', value: '0.90' },
      { label: 'Agent confidence for an automatic state correction', value: '0.85' },
      { label: 'Agent confidence below which a person reviews', value: '0.60' },
    ],
    approverRoles: [
      { tier: 'AUTO', approver: 'Nobody. Runs immediately.' },
      { tier: 'OPS', approver: 'Another Ops user, or a manager' },
      { tier: 'MANAGER', approver: 'A manager' },
      { tier: 'BLOCKED', approver: 'Nobody. Change the proposal.' },
    ],
  };
}

// ── Seed history ─────────────────────────────────────────────────────────────
function seededResolution(c: CaseDetail, init: Partial<ResolutionItem> & Pick<ResolutionItem, 'attempt' | 'actions' | 'rationale' | 'proposedBy' | 'policy' | 'createdAt'>): ResolutionItem {
  return {
    id: ids.next('execution').replace('exe_', 'res_'),
    caseId: c.id,
    runId: null,
    status: 'VALIDATED',
    approval: null,
    executions: [],
    validation: null,
    updatedAt: init.createdAt,
    ...init,
  };
}

const decision = (tier: PolicyTier, reasons: PolicyReason[], money: number, risk: RiskTier): PolicyDecision => ({ tier, reasons, version: POLICY_VERSION, moneyMovingMinor: money, riskTier: risk });

/** One PASS example, one FAIL then PASS example, two pending approvals and one rejection. */
export function seedResolutions(db: MockDb): MockDb {
  const ananya = actor(user('usr_ananya'));
  const rahul = actor(user('usr_rahul'));
  const meera = actor(user('usr_meera'));
  const byTag = (tag: string) => db.cases.find((c) => db.caseMeta[c.id]?.tag === tag);

  // 1. Single attempt, AUTO, verified PASS (the resolved ledger case).
  const resolved = byTag('resolved');
  if (resolved) {
    db.caseMeta[resolved.id] = { tag: 'resolved', risk: 'LOW' };
    const at = new Date(new Date(resolved.resolvedAt!).getTime() - 3 * MINUTE_MS).toISOString();
    const r = seededResolution(resolved, {
      attempt: 1,
      actions: [{ type: 'POST_LEDGER_ENTRY', params: { paymentId: resolved.entityRefs.paymentId!, amountMinor: resolved.amountMinor } }],
      rationale: 'Gateway captured and the order is PAID, but the ledger has no capture journal. Posting the missing journal.',
      proposedBy: ananya,
      policy: decision('AUTO', [reason('P6', 'AUTO', 'State corrections only; gateway shows the capture')], 0, 'LOW'),
      createdAt: at,
    });
    const tmp = { ...resolved, matrix: structuredClone(resolved.matrix) };
    execute(db, tmp, r, new Date(at).getTime() + 2 * S);
    db.resolutions.push(r);
  }

  // 2. replay_fails_then_replan: attempt 1 replays the webhook and fails verification; attempt 2 passes.
  const p = db.payments.find((x) => x.amountMinor === 15_750_00);
  if (p) {
    const c = caseFromPayment(db, p, { tag: 'replay_fails', type: 'PAYMENT_MISMATCH', severity: 'MEDIUM', ruleIds: ['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING'], openedAfterMs: 3 * MINUTE_MS, priority: 60, status: 'RESOLVED' });
    db.caseMeta[c.id] = { tag: 'replay_fails', risk: 'LOW' };
    db.cases.push(c);
    const cap = after(p.createdAt, 6 * S);
    c.lifecycle = [
      { at: p.createdAt, system: 'GATEWAY', title: 'Payment created', tone: 'neutral' },
      { at: cap, system: 'GATEWAY', title: `Captured ${formatMoney(p.amountMinor)}`, tone: 'ok' },
      { at: after(cap, S), system: 'WEBHOOK', title: 'payment.captured attempts 1 to 3 failed', detail: 'HTTP 500 from POST /webhooks/gateway. Retries exhausted.', tone: 'bad' },
      { at: after(cap, 21 * S), system: 'ORDER', title: 'PENDING to FAILED', detail: 'Payment timeout after 20 s with no captured webhook', tone: 'bad' },
      { at: after(c.openedAt, 22 * MINUTE_MS + S), system: 'WEBHOOK', title: 'Replay answered HTTP 409', detail: 'ORDER_VERSION_CONFLICT from the order service', tone: 'bad' },
      { at: after(c.openedAt, 39 * MINUTE_MS + 2 * S), system: 'ORDER', title: 'FAILED to PAID', detail: 'Marked paid by resolution attempt 2', tone: 'ok' },
      { at: after(c.openedAt, 39 * MINUTE_MS + 3 * S), system: 'LEDGER', title: `Posted ${formatMoney(p.amountMinor)}`, detail: 'Capture journal posted by resolution attempt 2', tone: 'ok' },
    ];
    p.openCase = { id: c.id, displayId: c.displayId };
    const t0 = new Date(c.openedAt).getTime() + 22 * MINUTE_MS;
    const r = refs(c);
    const amt = formatMoney(c.amountMinor);
    const a1: ResolutionItem = seededResolution(c, {
      attempt: 1,
      actions: [{ type: 'REPLAY_WEBHOOK_EVENT', params: { eventId: r.eventId } }],
      rationale: 'payment.captured failed with HTTP 500 three times. Replaying it should let the consumer mark the order paid and post the journal.',
      proposedBy: ananya,
      policy: decision('AUTO', [reason('P6', 'AUTO', 'State corrections only; gateway shows the capture')], 0, 'LOW'),
      createdAt: new Date(t0).toISOString(),
      updatedAt: new Date(t0 + 4 * S).toISOString(),
      executions: [
        {
          index: 0,
          type: 'REPLAY_WEBHOOK_EVENT',
          status: 'SUCCEEDED',
          idempotencyKey: `idem_${c.id.slice(-8)}_a1_0`,
          summary: `Gateway re-delivered payment.captured (${r.eventId}); consumer answered HTTP 409 ORDER_VERSION_CONFLICT`,
          error: null,
          startedAt: new Date(t0 + S).toISOString(),
          finishedAt: new Date(t0 + S + 1_204).toISOString(),
        },
      ],
      validation: {
        id: 'val_seed_a1',
        verdict: 'FAIL',
        at: new Date(t0 + 4 * S).toISOString(),
        checks: [
          { id: 'chk_a1_1', subject: `webhook.${r.eventId}.delivery`, description: 'Latest delivery status', expected: '2xx', actual: 'HTTP 409', pass: false, kind: 'POSTCONDITION', actionIndex: 0 },
          { id: 'chk_a1_2', subject: 'payment.internalStatus', description: 'Internal payment state equals gateway state', expected: 'CAPTURED', actual: 'PENDING', pass: false, kind: 'POSTCONDITION', actionIndex: 0 },
          { id: 'chk_a1_3', subject: 'order.status | gateway CAPTURED', description: 'A captured payment has a PAID order', expected: 'PAID', actual: 'FAILED', pass: false, kind: 'INVARIANT', actionIndex: null },
          { id: 'chk_a1_4', subject: 'ledger.credits = captured', description: 'Exactly one ledger credit equal to the captured amount', expected: `1 · ${amt}`, actual: '0', pass: false, kind: 'INVARIANT', actionIndex: null },
          { id: 'chk_a1_5', subject: 'settlement.line = captured', description: 'Settlement line equals the captured amount', expected: amt, actual: amt, pass: true, kind: 'INVARIANT', actionIndex: null },
        ],
      },
    });
    const t1 = t0 + 11 * MINUTE_MS;
    const a2 = seededResolution(c, {
      attempt: 2,
      actions: [
        { type: 'MARK_ORDER_PAID', params: { orderId: r.orderId, paymentId: r.paymentId } },
        { type: 'POST_LEDGER_ENTRY', params: { paymentId: r.paymentId, amountMinor: c.amountMinor } },
      ],
      rationale: 'Replay was rejected with ORDER_VERSION_CONFLICT, so the consumer will not move the order. Marking it paid directly and posting the capture journal.',
      proposedBy: ananya,
      policy: decision('OPS', [reason('P6', 'AUTO', 'State corrections only; gateway shows the capture'), reason('P7', 'OPS', 'Attempt 2 on this case')], 0, 'LOW'),
      createdAt: new Date(t1).toISOString(),
    });
    const approval = newApproval(db, c, a2, a2.createdAt);
    const decidedAt = new Date(t1 + 6 * MINUTE_MS).toISOString();
    Object.assign(approval, { status: 'APPROVED', decidedBy: rahul, decidedAt, comment: 'Checked the gateway capture and the settlement line. Approving.' });
    a2.approval = { id: approval.id, tier: 'OPS', status: 'APPROVED', decidedBy: rahul, comment: approval.comment, decidedAt };
    c.status = 'OPEN';
    execute(db, c, a2, new Date(decidedAt).getTime() + 2 * S);
    approval.case.status = c.status;
    db.resolutions.push(a1, a2);
  }

  // 3. Pending MANAGER approval: ₹78,000 refund on the cancelled order, requested by Ananya.
  const rfd = byTag('refund_never_initiated');
  if (rfd) {
    const opt = actionOptions(db, rfd).find((o) => o.type === 'INITIATE_REFUND')!;
    const res = seededResolution(rfd, {
      attempt: 1,
      status: 'AWAITING_APPROVAL',
      actions: [opt.action],
      rationale: 'Merchant cancelled the order (out of stock) 3 days ago and no refund exists at the gateway or internally. Full refund to the original RuPay card.',
      proposedBy: ananya,
      policy: decision('MANAGER', [reason('P2', 'MANAGER', 'Risk is HIGH'), reason('P3', 'MANAGER', 'Refund of ₹78,000.00 is over ₹10,000.00')], rfd.amountMinor, 'HIGH'),
      createdAt: ago(18 * MINUTE_MS),
    });
    db.resolutions.push(res);
    rfd.status = 'AWAITING_APPROVAL';
    newApproval(db, rfd, res, res.createdAt);
  }

  // 4. Pending OPS approval: settlement dispute requested by Rahul (Ananya can approve it).
  const stl = byTag('settlement_mismatch');
  if (stl) {
    const opt = actionOptions(db, stl).find((o) => o.type === 'RAISE_SETTLEMENT_DISPUTE')!;
    const res = seededResolution(stl, {
      attempt: 1,
      status: 'AWAITING_APPROVAL',
      actions: [opt.action],
      rationale: 'Batch fee line is 2.2% against the 2.0% contract rate on 46 captures. Raising a dispute for the ₹236.85 difference.',
      proposedBy: rahul,
      policy: decision('OPS', [reason('P9', 'OPS', 'Raises a claim with the acquirer')], 0, 'LOW'),
      createdAt: ago(42 * MINUTE_MS),
    });
    db.resolutions.push(res);
    stl.status = 'AWAITING_APPROVAL';
    newApproval(db, stl, res, res.createdAt);
  }

  // 5. Rejected: refund on the duplicate capture, rejected by Meera. The case stays open.
  const dup = byTag('duplicate_capture');
  if (dup) {
    const opt = actionOptions(db, dup).find((o) => o.type === 'INITIATE_REFUND')!;
    const res = seededResolution(dup, {
      attempt: 1,
      status: 'REJECTED',
      actions: [opt.action],
      rationale: 'Two captures for one order. Refunding the second capture in full.',
      proposedBy: ananya,
      policy: decision('OPS', [reason('P4', 'OPS', 'Refund of ₹4,999.00 is between ₹1,000.00 and ₹10,000.00')], dup.amountMinor, 'MEDIUM'),
      createdAt: ago(3 * HOUR_MS),
    });
    const approval = newApproval(db, dup, res, res.createdAt);
    const decidedAt = ago(2 * HOUR_MS + 20 * MINUTE_MS);
    const comment = 'The gateway auto-reverses the second capture within 24 hours. Wait for that before refunding.';
    Object.assign(approval, { status: 'REJECTED', decidedBy: meera, decidedAt, comment });
    res.approval = { id: approval.id, tier: 'OPS', status: 'REJECTED', decidedBy: meera, comment, decidedAt };
    db.resolutions.push(res);
  }

  // Newest first, like the server.
  db.approvals.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return db;
}
