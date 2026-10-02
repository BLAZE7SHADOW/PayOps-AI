import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import type { AuditEventRow } from '../db/rows';
import { auditEvents } from '../db/schema';
import { computeAuditHash, GENESIS_HASH, type ChainRow } from './chain';

/** Arbitrary constant. One transaction-scoped advisory lock serialises every audit append so seq and prev_hash never fork. */
const AUDIT_APPEND_LOCK = 7_701_012;

export type NewAuditRow = Omit<AuditEventRow, 'seq' | 'prevHash' | 'hash'>;

/**
 * Appends one row to the chain. Must run inside a transaction: the lock is released at commit,
 * so the chain order is the commit order.
 */
export async function appendAuditRow(tx: DbOrTx, row: NewAuditRow): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_APPEND_LOCK})`);
  const [last] = await tx
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash || GENESIS_HASH;
  const hash = computeAuditHash({ ...row, seq, prevHash });
  await tx.insert(auditEvents).values({ ...row, seq, prevHash, hash });
}

/** Rows in chain order, `limit` at a time, after `afterSeq`. */
export async function readChainPage(db: DbOrTx, afterSeq: number, limit: number): Promise<AuditEventRow[]> {
  return db
    .select()
    .from(auditEvents)
    .where(gt(auditEvents.seq, afterSeq))
    .orderBy(asc(auditEvents.seq))
    .limit(limit);
}

export function toChainRow(r: AuditEventRow): ChainRow {
  return { ...r };
}

/**
 * Gives a hash to rows written before the chain existed (migration 0012 numbered them). Runs
 * after migrations and does nothing once every row is sealed. The only UPDATE the append-only
 * trigger allows is on a row whose hash is still empty.
 */
export async function sealLegacyAuditRows(db: Db): Promise<number> {
  // A partial migration run (see migrate-upgrade.test.ts) stops before 0012; there is nothing to seal yet.
  const cols = await db.execute(sql`select 1 from information_schema.columns where table_name = 'audit_events' and column_name = 'hash'`);
  if (cols.rows.length === 0) return 0;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_APPEND_LOCK})`);
    const legacy = await tx.select().from(auditEvents).where(eq(auditEvents.hash, '')).orderBy(asc(auditEvents.seq));
    if (legacy.length === 0) return 0;
    const [before] = await tx
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .where(and(sql`${auditEvents.seq} < ${legacy[0]!.seq}`))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    let prevHash = before?.hash || GENESIS_HASH;
    for (const r of legacy) {
      const hash = computeAuditHash({ ...r, prevHash });
      await tx.update(auditEvents).set({ prevHash, hash }).where(eq(auditEvents.id, r.id));
      prevHash = hash;
    }
    return legacy.length;
  });
}
