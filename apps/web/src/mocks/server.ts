/** DEV-ONLY in-memory API used when VITE_MOCK_API=1. Mirrors docs/02-architecture.md §5. */
import {
  DAY_MS,
  OPEN_CASE_STATUSES,
  isOverdue,
  SCENARIOS,
  ApprovalDecisionBody,
  PreviewActionsBody,
  ProposeActionsBody,
  roleAtLeast,
  seededIds,
  type ApiErrorBody,
  type ApprovalItem,
  type ResolutionItem,
  type SessionUser,
  type CaseDetail,
  type CaseListItem,
  type GenerateScenarioBody,
  type GenerateScenarioResult,
  type OverviewMetrics,
  type Page,
  type PaymentDetail,
  type PaymentListItem,
} from '@payops/shared';
import { buildDb, exceptionsByType, type MockDb } from './fixtures';
import {
  MOCK_PASSWORD,
  USERS,
  demoAccounts,
  evaluate,
  execute,
  policyDocument,
  propose,
  resolutionView,
  seedResolutions,
  toSession,
  viewerApproval,
} from './resolution';

const freshDb = () => seedResolutions(buildDb());
let db: MockDb = freshDb();

// ── Mock realtime bus (mocks/realtime.ts subscribes) ─────────────────────────
export type MockEvent =
  | { name: 'case'; kind: 'created' | 'updated'; item: CaseListItem }
  | { name: 'approval'; kind: 'requested' | 'resolved'; item: ApprovalItem }
  | { name: 'resolution'; item: ResolutionItem };
type Listener = (e: MockEvent) => void;
const listeners = new Set<Listener>();
export const onMockEvent = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = (e: MockEvent, delay = 0) => setTimeout(() => listeners.forEach((l) => l(e)), delay);

// ── Mock session: sessionStorage stands in for the httpOnly cookie, mock mode only ─
const SESSION_KEY = 'payops.mock.session';
const mockMfa = { enabled: false, revoked: new Set<string>() };

function mockSessions(email: string) {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const all = [
    { id: 'ses_mock_here', createdAt: iso(3_600_000), lastSeenAt: iso(60_000), expiresAt: iso(-25_200_000), ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', mfaVerified: false, current: true },
    { id: 'ses_mock_phone', createdAt: iso(86_400_000 / 4), lastSeenAt: iso(1_800_000), expiresAt: iso(-20_000_000), ip: `203.0.113.${email.length}`, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', mfaVerified: false, current: false },
  ];
  return all.filter((s) => !mockMfa.revoked.has(s.id));
}

function currentUser(): SessionUser | null {
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  const u = USERS.find((x) => x.id === id);
  return u ? toSession(u) : null;
}
function setSession(u: SessionUser | null) {
  try {
    if (u) window.sessionStorage.setItem(SESSION_KEY, u.id);
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the session lasts until reload.
  }
}

const LATENCY_MS = 350;
let reqSeq = 0;
const requestId = () => `req_mock${String(++reqSeq).padStart(5, '0')}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId() },
  });
}
function error(status: number, code: string, message: string, details?: unknown): Response {
  const body: ApiErrorBody = { error: { code, message, requestId: requestId(), ...(details === undefined ? {} : { details }) } };
  return json(body, status);
}

function toListItem(p: PaymentDetail): PaymentListItem {
  const { card: _card, lifecycle: _l, matrix: _m, ...rest } = p;
  return rest;
}
function toCaseItem(c: CaseDetail): CaseListItem {
  c.overdue = isOverdue(c.dueAt ? new Date(c.dueAt) : null, OPEN_CASE_STATUSES.includes(c.status), new Date());
  const { matrix: _m, entityRefs: _e, customer: _c, merchant: _me, notes: _n, lifecycle: _l, resolvedAt: _r, resolution: _res, resolutionView: _rv, ...rest } = c;
  return rest;
}

function paginate<T>(all: T[], sp: URLSearchParams): Page<T> {
  const limit = Math.min(Number(sp.get('limit') ?? 25) || 25, 100);
  const start = Number(sp.get('cursor') ?? 0) || 0;
  const items = all.slice(start, start + limit);
  const next = start + limit < all.length ? String(start + limit) : null;
  return { items, nextCursor: next, total: all.length };
}

function overview(): OverviewMetrics {
  const since = Date.now() - DAY_MS;
  const today = db.payments.filter((p) => new Date(p.createdAt).getTime() > since && p.gatewayStatus === 'CAPTURED');
  const open = db.cases.filter((c) => OPEN_CASE_STATUSES.includes(c.status));
  return {
    capturedTodayMinor: today.reduce((s, p) => s + p.amountMinor, 0) + 4_218_650_00,
    capturedTodayCount: today.length + 312,
    openExceptions: open.length,
    awaitingApproval: db.approvals.filter((a) => a.status === 'PENDING').length,
    resolved7d: db.cases.filter((c) => c.status === 'RESOLVED').length + 23,
    resolvedByAgent7d: 0,
    validatorOutcomes7d: { PASS: 14, PARTIAL: 2, FAIL: 3 },
    exceptionsByType: exceptionsByType(db),
    performance: {
      resolutionTimeMedianMs: 14 * 60_000,
      resolvedCount: 23,
      autoResolutionRate: 0.61,
      agentAccuracy: 0.88,
      ratedCount: 8,
      approvalTurnaroundMedianMs: 47 * 60_000,
      decidedApprovalCount: 9,
      costPerCaseUsd: 0.012,
      casesWithRuns: 17,
    },
    oldestOpen: [...open].sort((a, b) => a.openedAt.localeCompare(b.openedAt)).slice(0, 5).map(toCaseItem),
  };
}

function generate(body: GenerateScenarioBody): GenerateScenarioResult {
  const seed = body.seed ?? Math.floor(Math.random() * 1_000_000);
  const gen = seededIds(seed);
  const info = SCENARIOS.find((s) => s.key === body.scenario);
  const paymentIds = Array.from({ length: 1 + body.noise }, () => gen.next('payment'));
  const orderIds = Array.from({ length: 1 + body.noise }, () => gen.next('order'));
  const casesOpened: GenerateScenarioResult['casesOpened'] = [];
  if (info?.expectedCaseType) {
    // Clone the hero case shape under a new id so the new link resolves.
    const template = db.cases.find((c) => c.type === info.expectedCaseType) ?? db.cases[0]!;
    const seq = (db.seq[info.expectedCaseType] += 1);
    const now = new Date().toISOString();
    const c: CaseDetail = {
      ...template,
      id: gen.next('case'),
      displayId: `${template.displayId.slice(0, 3)}-${String(seq).padStart(4, '0')}`,
      status: 'OPEN',
      openedAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
      matrix: structuredClone(template.matrix),
      mismatched: [...template.mismatched],
    };
    db.caseMeta[c.id] = { ...(db.caseMeta[template.id] ?? { tag: body.scenario, risk: 'LOW' }) };
    db.cases.unshift(c);
    casesOpened.push({ id: c.id, displayId: c.displayId, type: c.type });
    emit({ name: 'case', kind: 'created', item: toCaseItem(c) }, 400);
  }
  return {
    scenario: body.scenario,
    seed,
    created: { paymentIds, orderIds, batchIds: body.scenario === 'settlement_mismatch' ? [gen.next('settlementBatch')] : [] },
    casesOpened,
  };
}

/** AUTO proposals and approved ones execute a moment later, then the validator reports. */
function runExecution(caseId: string, resolutionId: string) {
  setTimeout(() => {
    const c = db.cases.find((x) => x.id === caseId);
    const res = db.resolutions.find((r) => r.id === resolutionId);
    if (!c || !res) return;
    execute(db, c, res);
    for (const a of db.approvals) if (a.case.id === c.id) a.case.status = c.status;
    emit({ name: 'resolution', item: res });
    emit({ name: 'case', kind: 'updated', item: toCaseItem(c) }, 50);
  }, 1_500);
}

interface MockNote { id: string; caseId: string; text: string; authorId: string; authorName: string; createdAt: string }
const mockNotes: MockNote[] = [];
const mockViews: Array<{ id: string; ownerId: string; name: string; filters: Record<string, unknown>; createdAt: string }> = [];

async function handle(method: string, url: URL, body: unknown, isJson: boolean): Promise<Response> {
  const sp = url.searchParams;
  const path = url.pathname;
  let m: RegExpExecArray | null;

  if (method === 'GET' && path === '/api/health') return json({ status: 'ok', aiMode: 'REPLAY' });
  if (method === 'GET' && path === '/api/agent-control') return json({ mode: 'NORMAL', reason: '', changedByName: null, changedAt: null });
  if (method === 'GET' && (path === '/api/runs' || /^\/api\/runs\/[^/]+\/(steps|feedback)$/.test(path))) return json({ items: [], nextCursor: null, total: 0 });

  // ── Auth ──
  if (method === 'GET' && path === '/api/auth/demo-accounts') return json(demoAccounts());
  if (method === 'POST' && path === '/api/auth/login') {
    const b = body as { email?: string; password?: string };
    const u = USERS.find((x) => x.email === String(b.email ?? '').toLowerCase());
    if (!u || b.password !== MOCK_PASSWORD) return error(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    setSession(u);
    return json(toSession(u));
  }
  if (method === 'POST' && path === '/api/auth/demo-login') {
    const u = USERS.find((x) => x.email === String((body as { email?: string }).email ?? '').toLowerCase());
    if (!u) return error(404, 'DEMO_ACCOUNT_NOT_FOUND', 'No demo account with that email.');
    setSession(u);
    return json(toSession(u));
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    setSession(null);
    return new Response(null, { status: 204, headers: { 'x-request-id': requestId() } });
  }
  const user = currentUser();
  if (!user) return error(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (method === 'GET' && path === '/api/auth/me') return json(user);
  // CSRF rule from the real server: state-changing requests must be JSON.
  if (method !== 'GET' && !isJson) return error(415, 'UNSUPPORTED_MEDIA_TYPE', 'State-changing requests must send application/json.');

  // Security page: MFA and sessions, in memory only.
  if (method === 'GET' && path === '/api/auth/security') {
    return json({ mfaEnabled: mockMfa.enabled, mfaRecommended: user.role === 'MANAGER' || user.role === 'ADMIN', sessions: mockSessions(user.email) });
  }
  if (method === 'POST' && path === '/api/auth/mfa/setup') {
    return json({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: `otpauth://totp/PayOps%20AI:${user.email}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PayOps%20AI` });
  }
  if (method === 'POST' && (path === '/api/auth/mfa/enable' || path === '/api/auth/mfa/disable')) {
    if (!/^\d{6}$/.test(String((body as { code?: string }).code ?? '').replace(/\s/g, ''))) return error(422, 'VALIDATION_FAILED', 'Enter the 6-digit code');
    mockMfa.enabled = path.endsWith('enable');
    return json(path.endsWith('enable') ? { mfaEnabled: true, otherSessionsRevoked: 0 } : { mfaEnabled: false });
  }
  if (method === 'POST' && /^\/api\/auth\/sessions\/[^/]+\/revoke$/.test(path)) {
    mockMfa.revoked.add(path.split('/')[4] ?? '');
    return json({ revoked: true });
  }
  if (method === 'POST' && path === '/api/auth/sessions/revoke-others') {
    mockSessions(user.email).filter((s) => !s.current).forEach((s) => mockMfa.revoked.add(s.id));
    return json({ revoked: 1 });
  }

  if (method === 'GET' && path === '/api/overview') return json(overview());
  if (method === 'GET' && path === '/api/policy') return json(policyDocument());

  // ── Resolution ──
  if ((m = /^\/api\/cases\/([^/]+)\/actions(\/preview)?$/.exec(path)) && method === 'POST') {
    const c = db.cases.find((x) => x.id === m![1]);
    if (!c) return error(404, 'CASE_NOT_FOUND', `No case with id ${m[1]}.`);
    if (!roleAtLeast(user.role, 'OPS')) return error(403, 'FORBIDDEN', 'Your role cannot propose resolutions.');
    const attempt = db.resolutions.filter((r) => r.caseId === c.id).length + 1;
    if (m[2]) {
      const parsed = PreviewActionsBody.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED', 'Invalid actions.', parsed.error.issues);
      return json(evaluate(db, c, parsed.data.actions, attempt));
    }
    const parsed = ProposeActionsBody.safeParse(body);
    if (!parsed.success) return error(422, 'VALIDATION_FAILED', 'Invalid proposal.', parsed.error.issues);
    if (db.approvals.some((a) => a.case.id === c.id && a.status === 'PENDING') || c.status === 'EXECUTING')
      return error(409, 'CONFLICT', 'A proposal on this case is already pending.');
    const pre = evaluate(db, c, parsed.data.actions, attempt);
    if (pre.decision.tier === 'BLOCKED')
      return error(422, 'POLICY_BLOCKED', 'Policy blocks this proposal.', { policy: pre.decision, preconditionFailures: pre.preconditionFailures });
    const { resolution, approval } = propose(db, c, user, parsed.data.actions, parsed.data.rationale);
    emit({ name: 'case', kind: 'updated', item: toCaseItem(c) }, 100);
    if (approval) emit({ name: 'approval', kind: 'requested', item: viewerApproval(db, approval, user) }, 200);
    else runExecution(c.id, resolution.id);
    return json(resolution, 201);
  }

  // ── Approvals ──
  if (method === 'GET' && path === '/api/approvals') {
    const scope = sp.get('scope') ?? 'pending';
    const list = db.approvals
      .filter((a) => scope === 'all' || (scope === 'pending' ? a.status === 'PENDING' : a.status !== 'PENDING'))
      .map((a) => viewerApproval(db, a, user));
    return json(paginate(list, sp));
  }
  if (method === 'GET' && (m = /^\/api\/approvals\/([^/]+)$/.exec(path))) {
    const a = db.approvals.find((x) => x.id === m![1]);
    if (!a) return error(404, 'APPROVAL_NOT_FOUND', `No approval with id ${m[1]}.`);
    const c = db.cases.find((x) => x.id === a.case.id)!;
    const resolution = db.resolutions.find((r) => r.id === a.resolutionId)!;
    return json({ ...viewerApproval(db, a, user), resolution, caseItem: toCaseItem(c) });
  }
  if (method === 'POST' && (m = /^\/api\/approvals\/([^/]+)\/decision$/.exec(path))) {
    const a = db.approvals.find((x) => x.id === m![1]);
    if (!a) return error(404, 'APPROVAL_NOT_FOUND', `No approval with id ${m[1]}.`);
    const parsed = ApprovalDecisionBody.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid decision.');
    if (a.status !== 'PENDING') return error(409, 'ALREADY_DECIDED', `This approval was already ${a.status.toLowerCase()}.`);
    const view = viewerApproval(db, a, user);
    if (!view.canDecide) return error(403, 'FORBIDDEN', view.cannotDecideReason ?? 'You cannot decide this approval.');
    const c = db.cases.find((x) => x.id === a.case.id)!;
    const res = db.resolutions.find((r) => r.id === a.resolutionId)!;
    const now = new Date().toISOString();
    const status = parsed.data.decision === 'APPROVE' ? 'APPROVED' : parsed.data.decision === 'REJECT' ? 'REJECTED' : 'ESCALATED';
    Object.assign(a, { status, decidedBy: { type: 'USER', id: user.id, name: user.name }, decidedAt: now, comment: parsed.data.comment || null });
    res.approval = { id: a.id, tier: a.tier, status, decidedBy: a.decidedBy, comment: a.comment, decidedAt: now };
    res.updatedAt = now;
    if (status === 'APPROVED') {
      res.status = 'EXECUTING';
      c.status = 'EXECUTING';
      runExecution(c.id, res.id);
    } else {
      res.status = status;
      c.status = status === 'REJECTED' ? 'OPEN' : 'ESCALATED';
    }
    a.case.status = c.status;
    const item = viewerApproval(db, a, user);
    emit({ name: 'approval', kind: 'resolved', item }, 100);
    emit({ name: 'resolution', item: res }, 150);
    emit({ name: 'case', kind: 'updated', item: toCaseItem(c) }, 200);
    return json(item);
  }

  if (method === 'GET' && path === '/api/payments') {
    const q = sp.get('q')?.toLowerCase();
    const list = db.payments.filter(
      (p) =>
        (!q || [p.paymentId, p.orderId, p.gwPaymentId, p.customer.name].some((v) => v.toLowerCase().includes(q))) &&
        (!sp.get('gatewayStatus') || p.gatewayStatus === sp.get('gatewayStatus')) &&
        (!sp.get('orderStatus') || p.orderStatus === sp.get('orderStatus')) &&
        (sp.get('mismatchOnly') !== 'true' || p.mismatch),
    );
    return json(paginate(list.map(toListItem), sp));
  }
  if (method === 'GET' && (m = /^\/api\/payments\/([^/]+)$/.exec(path))) {
    const p = db.payments.find((x) => x.paymentId === m![1]);
    return p ? json(p) : error(404, 'PAYMENT_NOT_FOUND', `No payment with id ${m[1]}.`);
  }

  if (method === 'GET' && path === '/api/cases') {
    const scope = sp.get('scope') ?? 'open';
    const q = sp.get('q')?.toUpperCase();
    const list = db.cases
      .filter((c) => {
        const open = OPEN_CASE_STATUSES.includes(c.status);
        return scope === 'all' || (scope === 'open' ? open : !open);
      })
      .filter((c) => !sp.get('type') || c.type === sp.get('type'))
      .filter((c) => !sp.get('severity') || c.severity === sp.get('severity'))
      .filter((c) => !q || c.displayId === q)
      .filter((c) => !sp.get('assigneeId') || (sp.get('assigneeId') === 'unassigned' ? !c.assignee : c.assignee?.id === sp.get('assigneeId')))
      .sort((a, b) => b.priority - a.priority)
      .map(toCaseItem)
      .filter((c) => sp.get('overdue') !== 'true' || c.overdue);
    return json(paginate(list, sp));
  }
  if (method === 'PUT' && (m = /^\/api\/cases\/([^/]+)\/assignee$/.exec(path))) {
    if (user.role === 'VIEWER') return error(403, 'FORBIDDEN', 'This needs the OPS role or above');
    const c = db.cases.find((x) => x.id === m![1]);
    if (!c) return error(404, 'CASE_NOT_FOUND', `No case with id ${m[1]}.`);
    const assigneeId = (body as { assigneeId: string | null }).assigneeId;
    c.assignee = assigneeId ? { id: assigneeId, name: assigneeId === user.id ? user.name : 'Another analyst' } : null;
    return json(toCaseItem(c));
  }
  // ── Operator workflow (P2 task 2) ──
  if (path === '/api/handoff' && method === 'GET') {
    const hours = Number(sp.get('hours') ?? 8);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) return error(422, 'VALIDATION_FAILED', 'hours must be between 1 and 72.');
    const now = new Date();
    const open = db.cases.filter((c) => OPEN_CASE_STATUSES.includes(c.status)).map(toCaseItem);
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const c of open) bySeverity[c.severity] += 1;
    const attention = open
      .map((c) => ({ c, reasons: [c.overdue && 'Overdue', c.severity === 'CRITICAL' && 'Critical', c.status === 'AWAITING_APPROVAL' && 'Waiting for approval', c.status === 'ESCALATED' && 'Escalated'].filter((r): r is string => Boolean(r)) }))
      .filter((x) => x.reasons.length > 0)
      .sort((a, b) => b.c.priority - a.c.priority)
      .slice(0, 10);
    return json({
      generatedAt: now.toISOString(),
      sinceHours: hours,
      since: new Date(now.getTime() - hours * 3_600_000).toISOString(),
      open: { total: open.length, overdue: open.filter((c) => c.overdue).length, awaitingApproval: open.filter((c) => c.status === 'AWAITING_APPROVAL').length, unassigned: open.filter((c) => !c.assignee).length, bySeverity },
      needsAttention: attention.map(({ c, reasons }) => {
        const last = mockNotes.filter((n) => n.caseId === c.id).at(-1);
        return {
          id: c.id, displayId: c.displayId, type: c.type, severity: c.severity, status: c.status, amountMinor: c.amountMinor,
          dueAt: c.dueAt, overdue: c.overdue, assigneeName: c.assignee?.name ?? null, reasons,
          lastNote: last ? { text: last.text, authorName: last.authorName, at: last.createdAt } : null,
        };
      }),
      resolved: { total: 0, by: { USER: 0, AGENT: 0, SYSTEM: 0 } },
      recentNotes: [...mockNotes].reverse().slice(0, 10).map((n) => ({ caseId: n.caseId, displayId: db.cases.find((c) => c.id === n.caseId)?.displayId ?? n.caseId, text: n.text, authorName: n.authorName, at: n.createdAt })),
    });
  }
  if ((m = /^\/api\/cases\/([^/]+)\/notes$/.exec(path))) {
    const c = db.cases.find((x) => x.id === m![1]);
    if (!c) return error(404, 'NOT_FOUND', `Case ${m[1]} not found`);
    if (method === 'GET') {
      const items = mockNotes.filter((n) => n.caseId === c.id).reverse();
      return json({ items, nextCursor: null, total: items.length });
    }
    if (method === 'POST') {
      if (user.role === 'VIEWER') return error(403, 'FORBIDDEN', 'This needs the OPS role or above');
      const text = String((body as { text?: string }).text ?? '').trim();
      if (!text) return error(422, 'VALIDATION_FAILED', 'Write a note first.');
      const note = { id: `note_${mockNotes.length + 1}`, caseId: c.id, text, authorId: user.id, authorName: user.name, createdAt: new Date().toISOString() };
      mockNotes.push(note);
      return json(note, 201);
    }
  }
  if (path === '/api/views') {
    if (method === 'GET') {
      const items = mockViews.filter((v) => v.ownerId === user.id).map(({ ownerId: _o, ...v }) => v);
      return json({ items, nextCursor: null, total: items.length });
    }
    if (method === 'POST') {
      const b = body as { name?: string; filters?: Record<string, unknown> };
      const name = String(b.name ?? '').trim();
      if (!name) return error(422, 'VALIDATION_FAILED', 'Name the view.');
      if (mockViews.some((v) => v.ownerId === user.id && v.name === name)) return error(409, 'CONFLICT', `You already have a view named "${name}".`);
      const view = { id: `viw_${mockViews.length + 1}`, ownerId: user.id, name, filters: b.filters ?? {}, createdAt: new Date().toISOString() };
      mockViews.push(view);
      const { ownerId: _o, ...out } = view;
      return json(out, 201);
    }
  }
  if (method === 'DELETE' && (m = /^\/api\/views\/([^/]+)$/.exec(path))) {
    const i = mockViews.findIndex((v) => v.id === m![1] && v.ownerId === user.id);
    if (i < 0) return error(404, 'NOT_FOUND', `Saved view ${m[1]} not found`);
    mockViews.splice(i, 1);
    return new Response(null, { status: 204 });
  }

  if (method === 'GET' && (m = /^\/api\/cases\/([^/]+)$/.exec(path))) {
    const c = db.cases.find((x) => x.id === m![1] || x.displayId === m![1]);
    return c ? json({ ...c, resolutionView: resolutionView(db, c, user) }) : error(404, 'CASE_NOT_FOUND', `No case with id ${m[1]}.`);
  }

  const simulator = path.startsWith('/api/simulator');
  if (simulator && user.role !== 'OPS' && user.role !== 'ADMIN') return error(403, 'FORBIDDEN', 'The simulator is for Ops and Admin users.');
  if (method === 'GET' && path === '/api/simulator/scenarios') return json(SCENARIOS);
  if (method === 'POST' && path === '/api/simulator/scenarios') {
    const b = body as GenerateScenarioBody;
    if (!SCENARIOS.some((s) => s.key === b.scenario)) return error(400, 'VALIDATION_FAILED', 'Unknown scenario.');
    return json(generate({ scenario: b.scenario, seed: b.seed, noise: b.noise ?? 0 }), 201);
  }
  if (method === 'POST' && path === '/api/simulator/reset') {
    db = freshDb();
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/audit') {
    const caseId = sp.get('caseId');
    const entityId = sp.get('entityId');
    const list = db.audit.filter((a) => (!caseId || a.entityId === caseId) && (!entityId || a.entityId === entityId));
    return json(paginate(list, sp));
  }

  return error(404, 'ROUTE_NOT_FOUND', `${method} ${path} is not part of the API.`);
}

export function installMockFetch(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const isJson = new Headers(init?.headers).get('content-type')?.includes('application/json') ?? false;
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    return handle(method, url, body, isJson);
  };
  console.warn(`[mock api] serving fixtures for /api (${db.cases.length} cases, ${db.payments.length} payments)`);
}
