// Visual check: node scripts/screenshots.mjs [baseUrl] [outDir] [width]
// Expects `pnpm dev:mock` running. Uses the preinstalled Chromium when present.
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '/tmp/web-shots-p2';
const width = Number(process.argv[4] ?? 1440);
const only = process.env.SHOTS ? new Set(process.env.SHOTS.split(',')) : null;
const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'];
const executablePath = candidates.find((p) => existsSync(p));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));

const want = (name) => !only || only.has(name);
async function snap(name, opts = {}) {
  if (want(name)) await page.screenshot({ path: `${out}/${name}-${width}.png`, ...opts });
}
async function go(path) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
}
async function shot(path, name, prepare, opts = {}) {
  if (!want(name)) return;
  // The app scrolls inside <main>, so "full page" means a tall viewport rather than fullPage.
  const { tall, ...rest } = opts;
  if (tall) await page.setViewportSize({ width, height: tall });
  await go(path);
  if (prepare) await prepare();
  await snap(name, rest);
  if (tall) await page.setViewportSize({ width, height: 900 });
}
async function signInAs(label) {
  await go('/login');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/overview/);
  await page.waitForTimeout(600);
}
async function caseHref(listPath, rowText) {
  await go(listPath);
  return page.locator(`tbody tr:has-text("${rowText}") a[href^="/cases/"]`).first().getAttribute('href');
}

// ── Signed out ──
await shot('/login', 'login');
await shot('/exceptions', 'login-redirect', async () => {
  await page.getByLabel('Email').fill('ops@payops.dev');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForTimeout(800);
});

// ── Ops analyst ──
await signInAs('Ananya Rao');
await shot('/overview', 'overview');
await shot('/payments', 'payments-drawer', async () => {
  await page.locator('tbody tr[data-row]').first().click();
  await page.waitForTimeout(900);
});
await shot('/exceptions', 'exceptions');

const hero = await caseHref('/exceptions', 'PAY-0042');
await shot(hero, 'case');
await shot(hero, 'resolve-drawer', async () => {
  await page.getByRole('button', { name: 'Resolve manually' }).click();
  await page.waitForTimeout(1400);
});
await shot(hero, 'resolve-drawer-refund', async () => {
  await page.getByRole('button', { name: 'Resolve manually' }).click();
  await page.waitForTimeout(600);
  await page.getByLabel('Refund customer').check();
  await page.getByLabel('Rationale').fill('Customer was charged and the order failed. Refunding in full while the order stays failed.');
  await page.waitForTimeout(1400);
  await page.locator('[role="dialog"] .overflow-y-auto').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
});
await shot(hero, 'resolve-drawer-invalid', async () => {
  await page.getByRole('button', { name: 'Resolve manually' }).click();
  await page.waitForTimeout(600);
  await page.getByLabel('Refund customer').check();
  const amount = page.getByLabel('Refund amount');
  await amount.fill('99,999');
  await amount.blur();
  await page.waitForTimeout(800);
});

const twoAttempts = await caseHref('/exceptions?scope=closed', '₹15,750.00');
await shot(twoAttempts, 'case-attempts', async () => {
  await page.waitForTimeout(200);
}, { tall: 2300 });
await shot(twoAttempts, 'case-attempt-1-fail', async () => {
  await page.getByRole('tab', { name: /Attempt 1/ }).click();
  await page.waitForTimeout(200);
}, { tall: 2300 });
const pending = await caseHref('/exceptions', 'Refund exception');
await shot(pending, 'case-pending-approval', async () => {
  await page.locator('#resolution-title').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
});

await shot('/approvals', 'approvals');
await shot('/approvals', 'approval-drawer-ops', async () => {
  await page.locator('tbody tr:has-text("Raise settlement dispute")').first().click();
  await page.waitForTimeout(1000);
});
await shot('/approvals', 'approval-drawer-manager', async () => {
  await page.locator('tbody tr:has-text("Refund customer")').first().click();
  await page.waitForTimeout(1000);
});
await shot('/approvals?scope=decided', 'approvals-decided');
await shot('/policy', 'policy');
await shot('/simulator', 'simulator');
await shot('/audit', 'audit');
await shot('/cases/case_missing', 'case-error');
// Loading state: capture before the mock latency elapses.
if (want('case-loading')) {
  await page.goto(`${base}${hero}`, { waitUntil: 'commit' });
  await page.waitForTimeout(250);
  await snap('case-loading');
}

// ── Viewer ──
if (!only || only.has('viewer-case')) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await signInAs('Kabir Shah');
  await shot(hero, 'viewer-case', async () => {
    await page.locator('#resolution-title').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  });
}

console.warn(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
