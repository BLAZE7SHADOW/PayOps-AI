/** DEV-ONLY in-memory API used when VITE_MOCK_API=1. Mirrors docs/02-architecture.md §5. */
import {
  DAY_MS,
  OPEN_CASE_STATUSES,
  SCENARIOS,
  seededIds,
  type ApiErrorBody,
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

let db: MockDb = buildDb();
type Listener = (kind: 'created' | 'updated', item: CaseListItem) => void;
const listeners = new Set<Listener>();
export const onMockCase = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const LATENCY_MS = 350;
let reqSeq = 0;
const requestId = () => `req_mock${String(++reqSeq).padStart(5, '0')}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId() },
  });
}
function error(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message, requestId: requestId() } };
  return json(body, status);
}

function toListItem(p: PaymentDetail): PaymentListItem {
  const { card: _card, lifecycle: _l, matrix: _m, ...rest } = p;
  return rest;
}
function toCaseItem(c: CaseDetail): CaseListItem {
  const { matrix: _m, entityRefs: _e, customer: _c, merchant: _me, notes: _n, lifecycle: _l, resolvedAt: _r, resolution: _res, ...rest } = c;
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
    awaitingApproval: db.cases.filter((c) => c.status === 'AWAITING_APPROVAL').length,
    resolved7d: db.cases.filter((c) => c.status === 'RESOLVED').length + 23,
    resolvedByAgent7d: 0,
    exceptionsByType: exceptionsByType(db),
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
    };
    db.cases.unshift(c);
    casesOpened.push({ id: c.id, displayId: c.displayId, type: c.type });
    setTimeout(() => listeners.forEach((l) => l('created', toCaseItem(c))), 400);
  }
  return {
    scenario: body.scenario,
    seed,
    created: { paymentIds, orderIds, batchIds: body.scenario === 'settlement_mismatch' ? [gen.next('settlementBatch')] : [] },
    casesOpened,
  };
}

async function handle(method: string, url: URL, body: unknown): Promise<Response> {
  const sp = url.searchParams;
  const path = url.pathname;
  let m: RegExpExecArray | null;

  if (method === 'GET' && path === '/api/health') return json({ ok: true });
  if (method === 'GET' && path === '/api/overview') return json(overview());

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
      .sort((a, b) => b.priority - a.priority);
    return json(paginate(list.map(toCaseItem), sp));
  }
  if (method === 'GET' && (m = /^\/api\/cases\/([^/]+)$/.exec(path))) {
    const c = db.cases.find((x) => x.id === m![1] || x.displayId === m![1]);
    return c ? json(c) : error(404, 'CASE_NOT_FOUND', `No case with id ${m[1]}.`);
  }

  if (method === 'GET' && path === '/api/simulator/scenarios') return json(SCENARIOS);
  if (method === 'POST' && path === '/api/simulator/scenarios') {
    const b = body as GenerateScenarioBody;
    if (!SCENARIOS.some((s) => s.key === b.scenario)) return error(400, 'VALIDATION_FAILED', 'Unknown scenario.');
    return json(generate({ scenario: b.scenario, seed: b.seed, noise: b.noise ?? 0 }), 201);
  }
  if (method === 'POST' && path === '/api/simulator/reset') {
    db = buildDb();
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
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    return handle(method, url, body);
  };
  console.warn(`[mock api] serving fixtures for /api (${db.cases.length} cases, ${db.payments.length} payments)`);
}
