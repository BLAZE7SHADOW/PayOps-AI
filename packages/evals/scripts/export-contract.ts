/**
 * Writes the contract fixtures the Python backend is tested against (D086): a database dump and the recorded response of every read-only API
 * route, produced by the TypeScript backend on seeded data with a fixed clock. The Python tests load the same rows into their own Postgres, serve
 * the same requests, and compare the JSON. Regenerate with `pnpm contract:export` after changing the seed data or a response shape.
 *
 * Output: python/payops/tests/contract/{db.json.gz, routes.json.gz}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createCore, createLogger, loadServerEnv } from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { createAgentRun, investigateAgentRun } from '@payops/agents';
import { seedDemoCases, seedWorld } from '../../simulator/src/index';
import { createApp } from '../../../apps/server/src/app';
import { seedDemoUsers } from '../../../apps/server/src/auth/demo-users';

const OUT = resolve(import.meta.dirname, '../../../python/payops/tests/contract');
const NOW = '2026-09-28T12:00:00.000Z';

interface Recorded {
  name: string;
  method: 'GET';
  path: string;
  status: number;
  contentType: string;
  body: unknown;
}

async function main() {
  process.env.NODE_ENV = 'test';
  const env = loadServerEnv({ NODE_ENV: 'test', AI_MODE: 'REPLAY', JWT_SECRET: 'contract-export-secret-0123456789', DEMO_MODE: 'true' });
  const t = await startTestDatabase();
  try {
    const core = createCore({ db: t.db, clock: fixedClock(NOW), events: { publish: () => {} } });
    await seedDemoUsers(t.db);
    await seedWorld(t.db, core.clock.now());
    await seedDemoCases(core);

    // Agent runs over recorded scenarios: one resolves on its own, one pauses for a manager, one escalates.
    const cases = await core.cases.list({ scope: 'all', limit: 100 } as never);
    const byDisplay = new Map(cases.items.map((c) => [c.displayId, c]));
    const targets: Array<[string, string]> = [['PAY-0001', 'captured_order_failed'], ['RFD-0002', 'refund_never_initiated'], ['STL-0001', 'settlement_mismatch']];
    for (const [displayId, scenarioKey] of targets) {
      const c = byDisplay.get(displayId);
      if (!c) continue;
      const { runId } = await createAgentRun(core, c.id, scenarioKey);
      await investigateAgentRun(core, env, runId, c.id, scenarioKey);
    }

    const app = createApp({ env, log: createLogger(env, 'test'), database: t, core, boss: { send: async () => null } as never });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${base}/api/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'manager@payops.dev' }) });
    const me = (await login.json()) as { id: string; email: string; name: string; role: string };
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    const recorded: Recorded[] = [];
    const get = async (name: string, path: string): Promise<unknown> => {
      const res = await fetch(base + path, { headers: { cookie } });
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const body = contentType.includes('json') ? JSON.parse(text) : text;
      recorded.push({ name, method: 'GET', path, status: res.status, contentType: contentType.split(';')[0] ?? '', body });
      return body;
    };

    await get('policy', '/api/policy');
    await get('overview', '/api/overview');
    await get('agent-control', '/api/agent-control');
    await get('handoff 8h', '/api/handoff');
    await get('handoff 1h', '/api/handoff?hours=1');
    await get('views', '/api/views');

    // Paged lists: follow the cursor until the end so every page is checked.
    const paged = async (name: string, path: string): Promise<Array<{ id?: string; paymentId?: string }>> => {
      const items: Array<{ id?: string; paymentId?: string }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const body = (await get(`${name} page ${page + 1}`, `${path}${sep}limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)) as { items: Array<{ id?: string; paymentId?: string }>; nextCursor: string | null };
        items.push(...body.items);
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      return items;
    };

    const payments = await paged('payments', '/api/payments');
    await get('payments default', '/api/payments');
    await get('payments captured', '/api/payments?gatewayStatus=CAPTURED');
    await get('payments mismatch only', '/api/payments?mismatchOnly=true');
    await get('payments order failed', '/api/payments?orderStatus=FAILED');
    await get('payments search', '/api/payments?q=pay_');
    for (const p of payments) await get(`payment ${p.paymentId}`, `/api/payments/${p.paymentId}`);

    const caseItems = await paged('cases', '/api/cases?scope=all');
    for (const q of ['scope=open', 'scope=closed', 'status=ESCALATED', 'type=REFUND_EXCEPTION', 'severity=HIGH', 'assigneeId=unassigned', 'overdue=true', 'q=PAY', 'scope=all&q=RFD-0002']) {
      await get(`cases ${q}`, `/api/cases?${q}`);
    }
    for (const c of caseItems) {
      await get(`case ${c.id}`, `/api/cases/${c.id}`);
      await get(`case notes ${c.id}`, `/api/cases/${c.id}/notes`);
      await get(`case records ${c.id}`, `/api/cases/${c.id}/records`);
    }

    await paged('audit', '/api/audit');
    await get('audit default', '/api/audit');
    await get('audit verify', '/api/audit/verify');
    await get('audit export', '/api/audit/export.csv');
    for (const c of caseItems.slice(0, 3)) await get(`audit case ${c.id}`, `/api/audit?caseId=${c.id}`);

    const runs = (await get('runs', '/api/runs')) as { items: Array<{ id: string; caseId: string }> };
    for (const r of runs.items) {
      await get(`run ${r.id}`, `/api/runs/${r.id}`);
      await get(`run steps ${r.id}`, `/api/runs/${r.id}/steps`);
      await get(`run feedback ${r.id}`, `/api/runs/${r.id}/feedback`);
      await get(`runs for case ${r.caseId}`, `/api/runs?caseId=${r.caseId}`);
    }

    const approvals = (await get('approvals', '/api/approvals')) as { items: Array<{ id: string }> };
    await get('approvals all', '/api/approvals?status=ALL');
    for (const a of approvals.items) await get(`approval ${a.id}`, `/api/approvals/${a.id}`);

    const hooks = await paged('webhooks', '/api/webhooks');
    await get('webhooks counts', '/api/webhooks/counts');
    await get('webhooks failed', '/api/webhooks?status=FAILED');
    for (const h of hooks.slice(0, 12)) await get(`webhook ${h.id}`, `/api/webhooks/${h.id}`);

    // The database, one JSON object per row. Postgres converts each row back into the right column types when Python loads it.
    const tables = (await t.pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r: { table_name: string }) => r.table_name);
    const db: Record<string, unknown[]> = {};
    for (const table of tables) {
      db[table] = (await t.pool.query(`select to_jsonb(x) as row from "${table}" x`)).rows.map((r: { row: unknown }) => r.row);
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'db.json.gz'), gzipSync(JSON.stringify({ now: NOW, user: me, tables: db })));
    writeFileSync(resolve(OUT, 'routes.json.gz'), gzipSync(JSON.stringify(recorded)));
    const counts = Object.fromEntries(Object.entries(db).map(([k, v]) => [k, v.length]).filter(([, n]) => (n as number) > 0));
    console.warn(`recorded ${recorded.length} responses; rows: ${JSON.stringify(counts)}`);
    server.close();
  } finally {
    await t.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
