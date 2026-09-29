/**
 * "Undo last reset" for the public demo. Before a reset wipes the demo data, the current rows
 * are copied into a side schema (`demo_undo`) with plain SQL; undo truncates the live tables and
 * copies them back in foreign-key order. Users are never touched. One level of undo: the next
 * reset replaces the snapshot. The snapshot lives in the database, so it survives an API restart.
 */
import { sql } from 'drizzle-orm';
import type { Core } from '@payops/core';

export type UndoCore = Pick<Core, 'db' | 'clock'>;

const SNAPSHOT_SCHEMA = 'demo_undo';
/** Tables that hold accounts or migration state, never snapshotted or wiped. */
const KEEP = new Set(['users']);

type Executor = Pick<UndoCore['db'], 'execute'>;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function demoTables(ex: Executor): Promise<string[]> {
  const res = await ex.execute(sql`select tablename from pg_tables where schemaname = current_schema()`);
  return rowsOf<{ tablename: string }>(res)
    .map((r) => r.tablename)
    .filter((t) => !KEEP.has(t))
    .sort();
}

/** Parent-first order from foreign keys, so restores never insert a child before its parent. */
async function insertOrder(ex: Executor, tables: string[]): Promise<string[]> {
  const res = await ex.execute(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c
    where c.contype = 'f' and c.connamespace = current_schema()::regnamespace
  `);
  const clean = (n: string) => n.replace(/^"|"$/g, '').replace(/^[^.]+\./, '').replace(/"/g, '');
  const set = new Set(tables);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of rowsOf<{ child: string; parent: string }>(res)) {
    const c = clean(child);
    const p = clean(parent);
    if (c !== p && set.has(c) && set.has(p)) deps.get(c)!.add(p);
  }
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => [...deps.get(t)!].every((p) => !remaining.has(p)));
    // A cycle should not exist; if one does, fall through and insert the rest in name order.
    const batch = ready.length > 0 ? ready : [...remaining];
    for (const t of batch) {
      ordered.push(t);
      remaining.delete(t);
    }
  }
  return ordered;
}

export interface UndoStatus {
  canUndo: boolean;
  /** ISO time the snapshot was taken (i.e. when the last reset started). */
  snapshotAt: string | null;
}

export async function undoStatus(core: UndoCore): Promise<UndoStatus> {
  const exists = rowsOf<{ ok: string | null }>(
    await core.db.execute(sql`select to_regclass(${`${SNAPSHOT_SCHEMA}._meta`}) as ok`),
  )[0]?.ok;
  if (!exists) return { canUndo: false, snapshotAt: null };
  const row = rowsOf<{ taken_at: string | Date }>(await core.db.execute(sql.raw(`select taken_at from ${SNAPSHOT_SCHEMA}._meta limit 1`)))[0];
  if (!row) return { canUndo: false, snapshotAt: null };
  return { canUndo: true, snapshotAt: new Date(row.taken_at).toISOString() };
}

/** Copies every demo table into the side schema, replacing any earlier snapshot. */
export async function snapshotDemoData(core: UndoCore): Promise<void> {
  await core.db.transaction(async (tx) => {
    const tables = await demoTables(tx);
    await tx.execute(sql.raw(`drop schema if exists ${SNAPSHOT_SCHEMA} cascade`));
    await tx.execute(sql.raw(`create schema ${SNAPSHOT_SCHEMA}`));
    for (const t of tables) {
      await tx.execute(sql.raw(`create table ${SNAPSHOT_SCHEMA}.${q(t)} as table ${q(t)}`));
    }
    await tx.execute(sql.raw(`create table ${SNAPSHOT_SCHEMA}._meta (taken_at timestamptz not null)`));
    await tx.execute(sql`insert into demo_undo._meta (taken_at) values (${core.clock.now().toISOString()})`);
  });
}

/** Restores the snapshot taken before the last reset. Throws if there is nothing to restore. */
export async function undoLastReset(core: UndoCore): Promise<void> {
  if (!(await undoStatus(core)).canUndo) throw new Error('There is no reset to undo.');
  await core.db.transaction(async (tx) => {
    const tables = await demoTables(tx);
    const snapshotted = new Set(
      rowsOf<{ tablename: string }>(
        await tx.execute(sql`select tablename from pg_tables where schemaname = ${SNAPSHOT_SCHEMA}`),
      ).map((r) => r.tablename),
    );
    const restorable = tables.filter((t) => snapshotted.has(t));
    await tx.execute(sql.raw(`truncate ${restorable.map(q).join(', ')} cascade`));
    for (const t of await insertOrder(tx, restorable)) {
      await tx.execute(sql.raw(`insert into ${q(t)} select * from ${SNAPSHOT_SCHEMA}.${q(t)}`));
    }
    await tx.execute(sql.raw(`drop schema ${SNAPSHOT_SCHEMA} cascade`));
  });
}
