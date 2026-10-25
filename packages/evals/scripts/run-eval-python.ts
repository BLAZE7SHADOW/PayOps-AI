/**
 * `pnpm eval:python`: runs every golden scenario (recorded cassettes and fixtures) through the Python agent service
 * (python/agents, D085) in REPLAY, and compares each outcome with the TypeScript graph's on the same
 * scenario. The Python service calls back into an in-process copy of the API (`/internal/agent`) that
 * shares one ephemeral database, so both runtimes see identical data and the same policy, executor and
 * validator. Fails if any hard gate fails, or if the two runtimes disagree on status, verdict, tier,
 * root cause, proposed actions or tools used.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createLogger, loadServerEnv } from '@payops/core';
import { createApp } from '../../../apps/server/src/app';
import { GOLDEN_SCENARIOS } from '../src/golden';
import { runEvalSuite, type AgentDriver } from '../src/runner';
import { summarize, type RunOutcome } from '../src/types';

const SECRET = 'python-eval-secret-0123456789';
const PORT = Number(process.env.PYTHON_EVAL_PORT ?? 8100);
const SERVICE_URL = process.env.AGENT_SERVICE_URL ?? `http://127.0.0.1:${PORT}`;

async function waitForHealth(url: string, child: ChildProcess | null): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child && child.exitCode !== null) throw new Error(`the Python service exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the Python service did not answer at ${url}/health`);
}

type Replay = Record<'llm' | 'jev', { exact: number; fallback: number }>;
const replayStats = new Map<string, Replay>();

async function post(path: string, body: unknown): Promise<{ status: string; interrupted: boolean; state: never; replay: Replay | null }> {
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-secret': SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as { status: string; interrupted: boolean; state: never; replay: Replay | null };
}

function differences(ts: RunOutcome, py: RunOutcome): string[] {
  const diffs: string[] = [];
  const same = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${name}: ts=${JSON.stringify(a)} python=${JSON.stringify(b)}`);
  };
  same('status', ts.status, py.status);
  same('verdict', ts.verdict, py.verdict);
  same('tier', ts.tier, py.tier);
  same('rootCause', ts.rootCause, py.rootCause);
  same('actionTypes', ts.actionTypes, py.actionTypes);
  same('toolsUsed', ts.toolsUsed, py.toolsUsed);
  same('toolCalls', ts.toolCalls, py.toolCalls);
  same('attempt', ts.attempt, py.attempt);
  same('groundingViolations', ts.groundingViolations, py.groundingViolations);
  return diffs;
}

async function main() {
  const cassetteGoldens = GOLDEN_SCENARIOS;
  console.warn(`Python parity: ${cassetteGoldens.length} golden scenarios (REPLAY)`);

  console.warn('Running the TypeScript graph for the baseline...');
  const baseline = (await runEvalSuite(cassetteGoldens, 'REPLAY')).outcomes;

  let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;
  let child: ChildProcess | null = null;
  try {
    const { outcomes } = await runEvalSuite(cassetteGoldens, 'REPLAY', async ({ core, db }) => {
      const env = loadServerEnv({ NODE_ENV: 'test', AGENT_INTERNAL_SECRET: SECRET });
      const app = createApp({ env, log: createLogger(env, 'test'), database: db, core, boss: { send: async () => null } as never });
      server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server!.once('listening', r));
      const apiPort = (server!.address() as AddressInfo).port;

      if (!process.env.AGENT_SERVICE_URL) {
        child = spawn('uv', ['run', 'uvicorn', 'payops_agents.app:app_factory', '--factory', '--port', String(PORT), '--log-level', 'warning'], {
          cwd: resolve(import.meta.dirname, '../../../python/agents'),
          env: { ...process.env, AGENT_INTERNAL_SECRET: SECRET, NODE_API_URL: `http://127.0.0.1:${apiPort}`, CHECKPOINTER: 'memory', AGENT_ALLOW_FIXTURES: '1' },
          stdio: ['ignore', 'inherit', 'inherit'],
        });
      }
      await waitForHealth(SERVICE_URL, child);

      const driver: AgentDriver = {
        start: async ({ runId, caseId, scenarioKey, fixture }) => {
          const r = await post('/runs', { runId, caseId, scenarioKey, fixture, aiMode: 'REPLAY' });
          if (r.replay) replayStats.set(runId, r.replay);
          return { state: r.state, interrupted: r.interrupted };
        },
        resume: async ({ runId, caseId, scenarioKey, fixture, decision }) => {
          const r = await post(`/runs/${runId}/resume`, { caseId, scenarioKey, fixture, aiMode: 'REPLAY', decision });
          if (r.replay) replayStats.set(`${runId}:resume`, r.replay);
          return { state: r.state, interrupted: r.interrupted };
        },
      };
      return driver;
    });

    let failed = 0;
    for (const py of outcomes) {
      const ts = baseline.find((b) => b.key === py.key)!;
      const diffs = differences(ts, py);
      const ok = py.ok && diffs.length === 0;
      if (!ok) failed++;
      console.warn(`${ok ? 'PASS' : 'FAIL'}  ${py.key}  status=${py.status} tier=${py.tier ?? '-'} verdict=${py.verdict ?? '-'} rootCause=${py.rootCause ?? '-'}`);
      for (const f of py.failures) console.warn(`       - gate: ${f}`);
      for (const d of diffs) console.warn(`       - differs from TypeScript: ${d}`);
    }
    // A fallback means a prompt or request did not hash to its recording, and the reader borrowed the nearest one.
    const totals = { exact: 0, fallback: 0 };
    for (const r of replayStats.values()) for (const k of ['llm', 'jev'] as const) { totals.exact += r[k].exact; totals.fallback += r[k].fallback; }
    console.warn(`\nReplay lookups: ${totals.exact} exact, ${totals.fallback} by fallback`);
    const s = summarize(outcomes);
    console.warn(`\n${outcomes.length - failed}/${outcomes.length} match the TypeScript run. rootCauseAccuracy=${(s.rootCauseAccuracy * 100).toFixed(1)}% meanToolCalls=${s.meanToolCalls.toFixed(1)}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    (child as ChildProcess | null)?.kill();
    (server as { close: () => void } | null)?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
