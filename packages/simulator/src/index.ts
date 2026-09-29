/**
 * The simulator plays the external world: it writes gateway tables (it IS the fake gateway) and
 * the internal records our own systems would have written, with faults injected per scenario.
 * Output is deterministic for a (scenario, seed) pair, relative to the core clock's "now".
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  SCENARIOS,
  seededIds,
  type GenerateScenarioBody,
  type GenerateScenarioResult,
  type ScenarioKey,
} from '@payops/shared';
import { AppError, tables, type Core } from '@payops/core';
import { ScenarioContext } from './context';
import { writeNoise } from './noise';
import { SCENARIO_WRITERS } from './scenarios';
import { WORLD, seedWorld } from './world';

export { WORLD, seedWorld } from './world';
export { snapshotDemoData, undoLastReset, undoStatus } from './undo';
export type { UndoStatus } from './undo';
export type { World, WorldCustomer, WorldMerchant, MerchantKey } from './world';

const SIMULATOR_ACTOR = { actorType: 'SYSTEM', actorId: 'simulator', actorName: 'Simulator' } as const;

export type SimulatorCore = Pick<Core, 'db' | 'clock' | 'audit' | 'reconciliation'>;

export interface GenerateInput {
  scenario: ScenarioKey;
  seed?: number;
  noise?: number;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 1_000_000);
}

/**
 * Writes a scenario (plus `noise` healthy payments) in one transaction, then runs detection on
 * the touched orders and batches. The same (scenario, seed) twice is rejected with CONFLICT
 * (it would recreate the same deterministic ids); pick another seed or reset.
 */
export async function generateScenario(
  core: SimulatorCore,
  input: GenerateInput | GenerateScenarioBody,
): Promise<GenerateScenarioResult> {
  const seed = input.seed ?? randomSeed();
  const noise = input.noise ?? 0;
  const key = `${input.scenario}:${seed}`;
  const now = core.clock.now();
  const title = SCENARIOS.find((s) => s.key === input.scenario)?.title ?? input.scenario;
  const conflict = () =>
    new AppError(
      'CONFLICT',
      `Scenario ${input.scenario} with seed ${seed} was already generated. Use another seed or reset the demo data.`,
    );

  if (await alreadyGenerated(core, key)) throw conflict();
  await seedWorld(core.db, now);

  let created: ScenarioContext['created'];
  try {
    created = await core.db.transaction(async (tx) => {
      const ctx = new ScenarioContext(tx, seededIds(key), now, WORLD);
      await SCENARIO_WRITERS[input.scenario](ctx);
      if (noise > 0) {
        const noiseCtx = new ScenarioContext(tx, seededIds(`${key}:noise`), now, WORLD);
        await writeNoise(noiseCtx, noise);
        await noiseCtx.flushSettlements();
        mergeCreated(ctx.created, noiseCtx.created);
      }
      await ctx.flushSettlements();
      await core.audit.record(
        {
          ...SIMULATOR_ACTOR,
          action: GENERATED_ACTION,
          entityType: 'scenario',
          entityId: key,
          summary: `Generated "${title}" (seed ${seed}) with ${ctx.created.paymentIds.length} payments, ${noise} of them background noise`,
          after: ctx.created,
        },
        tx,
      );
      return ctx.created;
    });
  } catch (err) {
    // Backstop for a concurrent request with the same seed: its deterministic ids collide.
    if (isUniqueViolation(err)) throw conflict();
    throw err;
  }

  // Detection runs after the commit, exactly as it would for real traffic.
  const orders = await core.reconciliation.checkOrders(created.orderIds);
  const batches = await core.reconciliation.checkBatches(created.batchIds);
  const casesOpened = [...orders.cases, ...batches.cases]
    .filter((c) => c.created)
    .map((c) => ({ id: c.case.id, displayId: c.case.displayId, type: c.case.type }));

  return { scenario: input.scenario, seed, created, casesOpened };
}

const GENERATED_ACTION = 'simulator.generated';

/** A (scenario, seed) pair is recorded in the audit log in the same transaction as its rows. */
async function alreadyGenerated(core: SimulatorCore, key: string): Promise<boolean> {
  const rows = await core.db
    .select({ id: tables.auditEvents.id })
    .from(tables.auditEvents)
    .where(and(eq(tables.auditEvents.action, GENERATED_ACTION), eq(tables.auditEvents.entityId, key)))
    .limit(1);
  return rows.length > 0;
}

function mergeCreated(into: ScenarioContext['created'], from: ScenarioContext['created']): void {
  into.paymentIds.push(...from.paymentIds);
  into.orderIds.push(...from.orderIds);
  into.batchIds.push(...from.batchIds);
}

/** Business and ops tables wiped by a reset. Users (and pg-boss) are kept. */
const RESET_TABLES = [
  'validation_results',
  'executions',
  'approvals',
  'resolutions',
  'disputes',
  'gw_settlement_lines',
  'gw_webhook_deliveries',
  'webhook_events',
  'gw_refunds',
  'gw_payments',
  'ledger_entries',
  'refunds',
  'payment_attempts',
  'payments',
  'orders',
  'settlements',
  'support_notes',
  'devices',
  'customers',
  'merchants',
  'cases',
  'counters',
  'audit_events',
] as const;

/** Wipes all demo data (keeping users), re-seeds the world and records the reset. */
export async function resetDemoData(core: Pick<Core, 'db' | 'clock' | 'audit'>): Promise<void> {
  await core.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`truncate ${RESET_TABLES.map((t) => `"${t}"`).join(', ')} cascade`));
    await seedWorld(tx, core.clock.now());
    await core.audit.record(
      {
        ...SIMULATOR_ACTOR,
        action: 'simulator.reset',
        entityType: 'system',
        entityId: 'demo-data',
        summary: 'Demo data reset and base world re-seeded',
      },
      tx,
    );
  });
}
