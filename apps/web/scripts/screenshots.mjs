// Visual check: node scripts/screenshots.mjs [baseUrl] [outDir] [width]
// Expects `pnpm dev:mock` running. Uses the preinstalled Chromium when present.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '/tmp/web-shots';
const width = Number(process.argv[4] ?? 1440);
const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'];
const executablePath = candidates.find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

async function shot(path, name, prepare) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (prepare) await prepare();
  await page.screenshot({ path: `${out}/${name}-${width}.png` });
}

await shot('/overview', 'overview');
await shot('/payments', 'payments-drawer', async () => {
  await page.locator('tbody tr[data-row]').first().click();
  await page.waitForTimeout(900);
});
await shot('/exceptions', 'exceptions');
await page.goto(`${base}/exceptions`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const href = await page.locator('tbody a[href^="/cases/"]', { hasText: 'PAY-0042' }).getAttribute('href');
await shot(href, 'case');
await page.goto(`${base}/exceptions`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const quarantined = await page.locator('tr:has-text("QUARANTINED TEXT") a[href^="/cases/"]').first().getAttribute('href');
await shot(quarantined, 'case-quarantined', async () => page.setViewportSize({ width, height: 1400 }));
await page.setViewportSize({ width, height: 900 });
const risk = await page.locator('tr:has-text("Risk review") a[href^="/cases/"]').first().getAttribute('href').catch(() => null);
if (risk) await shot(risk, 'case-agree');
await shot('/simulator', 'simulator', async () => {
  await page.getByRole('button', { name: 'Generate' }).nth(1).click();
  await page.waitForTimeout(1200);
});
await shot('/audit', 'audit');
await shot('/cases/case_missing', 'case-error');
// Loading state: capture before the mock latency elapses.
await page.goto(`${base}${href}`, { waitUntil: 'commit' });
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/case-loading-${width}.png` });

console.warn(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
