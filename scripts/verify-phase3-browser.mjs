// Explicit LIVE acceptance check; never loaded by Vitest. Uses only an isolated local database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = requireWeb('playwright-core');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let server, browser;
const errors = [];
async function startServer() {
  server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], { env: { ...process.env, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/postgres', AI_MODE: 'LIVE', RECONCILE_SWEEP_MS: '0', LOG_LEVEL: 'fatal' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://127.0.0.1:4000/api/auth/demo-accounts')).ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('Local server did not start');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
}
async function newBrowser(email) {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1100 }, baseURL: 'http://localhost:5173' });
  await context.request.post('/api/auth/demo-login', { data: { email } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page };
}
async function read(context, path) {
  const res = await context.request.get(`/api${path}`);
  assert.equal(res.status(), 200, path);
  return res.json();
}
async function waitRun(context, caseId, status) {
  for (let i = 0; i < 90; i++) {
    const runs = await read(context, `/runs?caseId=${caseId}`);
    const run = runs.items[0];
    if (run?.status === status) return run;
    if (run?.status === 'FAILED' || run?.status === 'ESCALATED') throw new Error(`Run ended ${run.status}`);
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${status}`);
}
async function generate(context, scenario, seed) {
  const res = await context.request.post('/api/simulator/scenarios', { data: { scenario, seed } });
  assert.equal(res.status(), 201);
  return (await res.json()).casesOpened[0].id;
}
try {
  await mkdir('.data/phase3-browser', { recursive: true });
  await startServer();
  let { context, page } = await newBrowser('ops@payops.dev');
  const seed = Math.floor(Date.now() / 1000) % 1000000;
  const caseId = await generate(context, 'refund_never_initiated', seed);
  await page.goto(`/cases/${caseId}`);
  await page.getByRole('button', { name: 'Start investigation', exact: true }).click();
  const pending = await waitRun(context, caseId, 'AWAITING_APPROVAL');
  assert.equal(pending.policy.tier, 'MANAGER');
  await page.getByRole('link', { name: 'Review approval', exact: true }).waitFor();
  await page.screenshot({ path: '.data/phase3-browser/1-pending.png', fullPage: true });
  const before = (await read(context, `/runs/${pending.id}/steps`)).items;
  await browser.close();
  await stopServer();
  await startServer();
  ({ context, page } = await newBrowser('manager@payops.dev'));
  let stepReads = 0;
  page.on('request', (r) => { if (r.url().includes(`/runs/${pending.id}/steps`)) stepReads++; });
  await page.goto(`/cases/${caseId}`);
  await page.getByRole('link', { name: 'Review approval', exact: true }).waitFor();
  await page.getByText('Live', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Review approval', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const resolved = await waitRun(context, caseId, 'RESOLVED');
  assert.equal(resolved.validation.verdict, 'PASS');
  const after = (await read(context, `/runs/${pending.id}/steps`)).items;
  await page.goto(`/cases/${caseId}`);
  await page.getByText('Live', { exact: true }).waitFor();
  await stopServer();
  await page.getByText('Reconnecting', { exact: true }).waitFor({ timeout: 15000 });
  await startServer();
  await page.getByText('Live', { exact: true }).waitFor({ timeout: 15000 });
  assert.ok(stepReads > 0, 'Reconnect must rebuild persisted steps');
  assert.equal(after.filter(s => s.node === 'triage').length, before.filter(s => s.node === 'triage').length);
  assert.equal(after.filter(s => s.kind === 'PROPOSAL_CREATED').length, 1);
  await page.goto(`/cases/${caseId}`);
  await page.getByRole('heading', { name: 'Evidence', exact: true }).waitFor();
  const citation = page.locator('a[href^="#evidence-"]').first();
  await citation.waitFor();
  const anchor = (await citation.getAttribute('href')).slice(1);
  await citation.focus();
  await citation.click();
  assert.equal(await page.locator(`#${anchor}`).evaluate((element) => element.id), anchor);
  await page.screenshot({ path: '.data/phase3-browser/2-resumed.png', fullPage: true });
  const capturedId = await generate(context, 'captured_order_failed', seed + 1);
  await page.goto(`/cases/${capturedId}`);
  let streamedSteps = 0;
  page.on('websocket', socket => socket.on('framereceived', frame => { if (String(frame.payload).includes('node.started')) streamedSteps++; }));
  // The shell socket already exists, so count authoritative step requests triggered by events too.
  let traceReads = 0;
  page.on('request', r => { if (/\/runs\/[^/]+\/steps/.test(r.url())) traceReads++; });
  await page.getByRole('button', { name: 'Start investigation', exact: true }).click();
  const captured = await waitRun(context, capturedId, 'RESOLVED');
  assert.equal(captured.policy.tier, 'AUTO');
  assert.equal(captured.validation.verdict, 'PASS');
  assert.ok(traceReads > 1, 'Live trace must refresh while the run progresses');
  await page.getByRole('heading', { name: 'Root cause', exact: true }).waitFor();
  await page.screenshot({ path: '.data/phase3-browser/3-auto.png', fullPage: true });
  assert.deepEqual(errors, [], 'No browser runtime errors');
  const report = { mode: 'LIVE', manager: { runId: pending.id, verdict: resolved.validation.verdict, restart: true, browserClosed: true, triageRepeated: false }, captured: { runId: captured.id, tier: captured.policy.tier, verdict: captured.validation.verdict }, reconnectStepReads: stepReads, traceReads, streamedSteps, evidenceKeyboardLink: true, browserErrors: errors };
  await writeFile('.data/phase3-browser/report.json', JSON.stringify(report, null, 2));
  console.warn(JSON.stringify(report));
} finally {
  await browser?.close();
  await stopServer();
}
