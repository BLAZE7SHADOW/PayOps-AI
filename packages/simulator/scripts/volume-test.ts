/**
 * Volume test (P3 task 3): 10,000 healthy payments plus injected faults, then timed detection.
 * Run: `npx pnpm@10.28.0 volume` (add `--write` to save docs/VOLUME-TEST.md, `--payments=N` to resize).
 *
 * Runs on PGlite (Postgres compiled to WASM, single connection), so absolute times are a
 * pessimistic reference for a real Postgres. What it proves is the shape: detection is chunked,
 * memory stays flat, a second sweep changes nothing, and injected faults are all found.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SCENARIOS, seededIds } from '@payops/shared';
import { createCore } from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { ScenarioContext } from '../src/context';
import { writeNoise } from '../src/noise';
import { SCENARIO_WRITERS } from '../src/scenarios';
import { WORLD, seedWorld } from '../src/world';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PAYMENTS = Number(arg('payments') ?? 10_000);
const SEED_BATCH = 500;
const WRITE = process.argv.includes('--write');
const NOW = '2026-09-28T12:00:00.000Z';

const ms = (n: number) => Math.round(n);
const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

async function main() {
  const t = await startTestDatabase();
  const core = createCore({ db: t.db, clock: fixedClock(NOW) });
  const now = core.clock.now();
  const rows: string[][] = [];
  let peakRss = mb();
  const bump = () => (peakRss = Math.max(peakRss, mb()));

  try {
    await seedWorld(core.db, now);

    // 1. Healthy background traffic, in transactions of SEED_BATCH payments.
    const seedNoise = await timed(async () => {
      let done = 0;
      for (let batch = 0; done < PAYMENTS; batch++) {
        const n = Math.min(SEED_BATCH, PAYMENTS - done);
        await core.db.transaction(async (tx) => {
          const ctx = new ScenarioContext(tx, seededIds(`volume:noise:${batch}`), now, WORLD);
          await writeNoise(ctx, n);
          await ctx.flushSettlements();
        });
        done += n;
        bump();
      }
    });

    // 2. Faults: every scenario that should open a case, three seeds each. Written without
    //    running detection, so the sweep below is the thing that finds them.
    const faulty = SCENARIOS.filter((s) => s.expectedCaseType !== null);
    const SEEDS_PER_SCENARIO = 3;
    const seedFaults = await timed(async () => {
      for (const info of faulty) {
        for (let s = 1; s <= SEEDS_PER_SCENARIO; s++) {
          await core.db.transaction(async (tx) => {
            const ctx = new ScenarioContext(tx, seededIds(`volume:${info.key}:${s}`), now, WORLD);
            await SCENARIO_WRITERS[info.key](ctx);
            await ctx.flushSettlements();
          });
        }
      }
    });
    const expectedCases = faulty.length * SEEDS_PER_SCENARIO;

    const totalPayments = (await t.pool.query<{ n: string }>('select count(*)::text as n from payments')).rows[0]?.n ?? '?';

    // 3. First full sweep: everything is unchecked, faults get found.
    const sweep1 = await timed(() => core.reconciliation.sweep({ sinceDays: 30 }));
    bump();
    // 4. Second sweep: nothing changed, so nothing may open and nothing may update.
    const sweep2 = await timed(() => core.reconciliation.sweep({ sinceDays: 30 }));
    bump();

    // 5. What an incremental check costs (the webhook path): one order, then a 200-order chunk.
    const orderIds = (await t.pool.query<{ id: string }>('select id from orders order by id limit 200')).rows.map((r) => r.id);
    const one = await timed(() => core.reconciliation.checkOrders(orderIds.slice(0, 1)));
    const chunk = await timed(() => core.reconciliation.checkOrders(orderIds));

    const casesOpen = Number((await t.pool.query<{ n: string }>('select count(*)::text as n from cases')).rows[0]!.n);

    const checks = [
      ['Cases opened by first sweep equal injected faults', sweep1.value.opened === expectedCases && casesOpen === expectedCases, `${sweep1.value.opened} opened, ${casesOpen} in table, ${expectedCases} injected`],
      ['Healthy payments opened no case', casesOpen === expectedCases, `${casesOpen - expectedCases} extra cases`],
      ['Second sweep opened nothing', sweep2.value.opened === 0, `${sweep2.value.opened} opened`],
      // `updated` counts open cases re-evaluated; `cases` holds only those whose data changed.
      ['Second sweep changed no case (no events published)', sweep2.value.cases.length === 0, `${sweep2.value.cases.length} changed, ${sweep2.value.updated} re-evaluated`],
    ] as const;

    const orders = sweep1.value.checked;
    rows.push(
      ['Seed healthy payments', `${PAYMENTS}`, `${ms(seedNoise.ms)} ms`, `${Math.round(PAYMENTS / (seedNoise.ms / 1000))} payments/s`],
      ['Seed faulty scenarios', `${expectedCases} cases worth`, `${ms(seedFaults.ms)} ms`, ''],
      ['Full sweep #1 (finds faults)', `${orders} orders and batches`, `${ms(sweep1.ms)} ms`, `${Math.round(orders / (sweep1.ms / 1000))} checks/s`],
      ['Full sweep #2 (no changes)', `${sweep2.value.checked} orders and batches`, `${ms(sweep2.ms)} ms`, `${Math.round(sweep2.value.checked / (sweep2.ms / 1000))} checks/s`],
      ['Check 200 orders (one chunk)', '200 orders', `${ms(chunk.ms)} ms`, `${(chunk.ms / 200).toFixed(2)} ms per order`],
      ['Check 1 order (webhook path)', '1 order', `${ms(one.ms)} ms`, ''],
    );

    const table = (head: string[], body: string[][]) =>
      [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

    const md = [
      '# Volume test',
      '',
      `Generated by \`npx pnpm@10.28.0 volume --write\` on ${new Date().toISOString().slice(0, 10)}. Deterministic data (seeded ids); timings vary by machine.`,
      '',
      `**Dataset:** ${totalPayments} payments (${PAYMENTS} healthy background payments across 3 merchants, spread over 3 days, plus ${expectedCases} injected faulty cases: ${SEEDS_PER_SCENARIO} seeds of each of ${faulty.length} fault scenarios).`,
      '',
      '**Environment:** PGlite (Postgres compiled to WASM, one connection, in memory), Node ' + process.version + ', ' + process.platform + '/' + process.arch + '. A real Postgres on Supabase will differ, mostly because of network round trips per query. Treat these as the relative shape, not a production benchmark.',
      '',
      '## Timings',
      '',
      table(['Step', 'Size', 'Time', 'Rate'], rows),
      '',
      `Peak process memory (RSS): ${peakRss} MB. This includes the in-memory PGlite database itself (it holds all 10,000 payments), so it overstates what the app would use against a real Postgres. Detection itself loads orders in chunks of 200.`,
      '',
      '## Correctness checks',
      '',
      table(['Check', 'Result', 'Detail'], checks.map(([name, ok, detail]) => [name, ok ? 'pass' : 'FAIL', detail])),
      '',
      '## Reading the numbers',
      '',
      '- Sweep #1 is the worst case: every order is loaded, evaluated and written back (`payments.recon`), and cases are opened.',
      '- Sweep #2 is the steady state for the periodic job. Every order is still re-evaluated and existing cases are re-read, but no case changes and no event is published.',
      '- The webhook path checks only the touched orders, so its cost depends on the number of orders in the event, not on table size.',
      '- Detection is pure code (rules D1 to D7). No LLM or Jev call happens here, so this volume adds no model cost until a case reaches an agent run.',
      '',
    ].join('\n');

    console.warn(md);
    if (WRITE) {
      writeFileSync(new URL('../../../docs/VOLUME-TEST.md', import.meta.url), md);
      console.warn('\nWrote docs/VOLUME-TEST.md');
    }
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await t.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
