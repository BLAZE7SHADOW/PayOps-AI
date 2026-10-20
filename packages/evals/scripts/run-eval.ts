/**
 * `pnpm eval` (REPLAY, default) / `pnpm eval:live` (--mode=live) — docs/03-agent-system.md §17,
 * docs/06-phases.md Phase 5 task 3. Runs every golden scenario (../src/golden.ts), prints a
 * summary, and:
 *  - REPLAY: exits non-zero if any golden scenario's hard gates (status/verdict/tier/forbidden
 *    actions/quarantine/max tool calls) fail. This is the check CI runs.
 *  - LIVE: additionally writes the full markdown report to docs/evals/<date>.md (still exits
 *    non-zero on a hard-gate failure — a LIVE run that fails its own gates should never be
 *    silently committed as a report).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_CASSETTE_DIR, loadServerEnv } from '@payops/core';
import { renderMarkdownReport, type ReportMeta } from '../src/report';
import { runEvalSuite, type EvalMode } from '../src/runner';
import { checkThresholds, summarize } from '../src/types';

function parseMode(): EvalMode {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  const mode = (arg?.split('=')[1] ?? 'replay').toUpperCase();
  if (mode !== 'REPLAY' && mode !== 'LIVE') {
    throw new Error(`--mode must be "replay" or "live", got "${mode}"`);
  }
  return mode;
}

/** What this run used, written into the report. Only model names and a commit, never a key. */
function runMeta(mode: EvalMode): ReportMeta {
  let gitCommit = 'unknown';
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // Not a git checkout: leave it unknown.
  }
  const manifest = `${DEFAULT_CASSETTE_DIR}/manifest.json`;
  const cassetteScenarios = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as unknown[]).length : 0;
  if (mode === 'LIVE') {
    const env = loadServerEnv({ AI_MODE: 'LIVE' });
    return { gitCommit, llmModel: env.AI_MODEL, decisionModel: env.JEV_MODEL, cassetteScenarios };
  }
  return { gitCommit, llmModel: 'recorded (REPLAY)', decisionModel: 'recorded (REPLAY)', cassetteScenarios };
}

async function main() {
  const mode = parseMode();
  console.warn(`Running ${mode === 'LIVE' ? 'pnpm eval:live' : 'pnpm eval'} (${mode})...`);
  const { outcomes } = await runEvalSuite(undefined, mode);
  const summary = summarize(outcomes);

  for (const o of outcomes) {
    console.warn(
      `${o.ok ? 'PASS' : 'FAIL'}  ${o.key}  status=${o.status} tier=${o.tier ?? '-'} verdict=${o.verdict ?? '-'} rootCause=${o.rootCause ?? '-'}`,
    );
    if (!o.ok) for (const f of o.failures) console.warn(`       - ${f}`);
  }
  console.warn(
    `\n${summary.passed}/${summary.total} passed. toolSetMatch=${summary.toolSetMatchRate === null ? 'n/a' : `${(summary.toolSetMatchRate * 100).toFixed(1)}%`} rootCauseAccuracy=${(summary.rootCauseAccuracy * 100).toFixed(1)}% ` +
      `meanToolCalls=${summary.meanToolCalls.toFixed(1)} meanLatency=${Math.round(summary.meanLatencyMs)}ms totalCost=$${summary.totalCostUsd.toFixed(4)}`,
  );

  if (mode === 'LIVE') {
    const date = new Date().toISOString().slice(0, 10);
    const report = renderMarkdownReport(outcomes, summary, {
      generatedAt: new Date().toISOString(),
      mode,
      meta: runMeta(mode),
    });
    mkdirSync('docs/evals', { recursive: true });
    const path = `docs/evals/${date}.md`;
    writeFileSync(path, report);
    console.warn(`\nWrote ${path}`);
  }

  if (summary.failed > 0) {
    console.error(`\n${summary.failed} golden scenario(s) failed their hard gates.`);
    process.exitCode = 1;
  }
  for (const message of checkThresholds(summary)) {
    console.error(`Aggregate limit breached: ${message}.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('eval run failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
