import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import type { CaseRow } from '../db/rows';
import { cases } from '../db/schema';
import { notFound } from '../errors';
import type { PaymentGatewayPort } from '../ports/gateway';
import { checkBatch } from '../reconciliation/settlement';
import { loadBatch, loadOrderSnapshots } from '../services/snapshot.loader';
import type { CaseState } from './types';

/** Loads a case and everything its actions may need, fresh from the database and the gateway. */
export async function loadCaseState(
  db: DbOrTx,
  gateway: PaymentGatewayPort,
  caseIdOrRow: string | CaseRow,
  now: Date,
): Promise<CaseState> {
  let row: CaseRow | undefined;
  if (typeof caseIdOrRow === 'string') {
    [row] = await db.select().from(cases).where(eq(cases.id, caseIdOrRow)).limit(1);
    if (!row) throw notFound('Case', caseIdOrRow);
  } else {
    row = caseIdOrRow;
  }
  const refs = row.entityRefs;
  const [snapshots, batch] = await Promise.all([
    refs.orderId ? loadOrderSnapshots(db, gateway, [refs.orderId], now) : Promise.resolve([]),
    refs.batchId ? loadBatch(db, gateway, refs.batchId) : Promise.resolve(null),
  ]);
  return {
    now,
    case: row,
    order: snapshots[0] ?? null,
    batch: batch ? { data: batch, check: checkBatch(batch) } : null,
  };
}
