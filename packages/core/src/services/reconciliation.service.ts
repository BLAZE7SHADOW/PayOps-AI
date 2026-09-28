/**
 * Runs detection: loads snapshots, stores each payment's matrix verdict, and opens or updates
 * cases. Each case write (plus its audit row) is one transaction; realtime events go out only
 * after the commit so the UI never sees a case that was rolled back.
 */
import { and, asc, gt, gte, inArray, sql } from 'drizzle-orm';
import { DAY_MS, OPS_EVENTS, ROOMS, type CaseListItem } from '@payops/shared';
import type { Db } from '../db/client';
import type { ReconState } from '../db/schema';
import { orders, settlements } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import type { EventPublisherPort } from '../ports/events';
import type { PaymentGatewayPort } from '../ports/gateway';
import { evaluateOrder, groupHits, snapshotEntityRefs, type CaseCandidate } from '../reconciliation/candidates';
import { blankMatrix, buildMatrix } from '../reconciliation/matrix';
import { checkBatch } from '../reconciliation/settlement';
import type { CaseService } from './case.service';
import { loadBatches, loadOrderSnapshots } from './snapshot.loader';

export const RECON_CHUNK_SIZE = 200;

export interface TouchedCase {
  case: CaseListItem;
  created: boolean;
}

export interface ReconciliationSummary {
  checked: number;
  opened: number;
  updated: number;
  cases: TouchedCase[];
}

const emptySummary = (): ReconciliationSummary => ({ checked: 0, opened: 0, updated: 0, cases: [] });

function mergeSummary(into: ReconciliationSummary, from: ReconciliationSummary): ReconciliationSummary {
  into.checked += from.checked;
  into.opened += from.opened;
  into.updated += from.updated;
  into.cases.push(...from.cases);
  return into;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
    private readonly cases: CaseService,
    private readonly events: EventPublisherPort,
  ) {}

  /** Re-evaluates the given orders: updates payments.recon and opens or updates cases. */
  async checkOrders(orderIds: readonly string[]): Promise<ReconciliationSummary> {
    const summary = emptySummary();
    for (const chunk of chunks([...new Set(orderIds)], RECON_CHUNK_SIZE)) {
      mergeSummary(summary, await this.checkOrderChunk(chunk));
    }
    return summary;
  }

  private async checkOrderChunk(orderIds: string[]): Promise<ReconciliationSummary> {
    const now = this.clock.now();
    const snapshots = await loadOrderSnapshots(this.db, this.gateway, orderIds, now);
    const reconRows: Array<{ paymentId: string; recon: ReconState; mismatch: boolean }> = [];
    const candidates: CaseCandidate[] = [];
    for (const s of snapshots) {
      const evaluation = evaluateOrder(s);
      if (s.payment) {
        reconRows.push({
          paymentId: s.payment.id,
          recon: { mismatched: evaluation.matrix.mismatched, checkedAt: now.toISOString() },
          mismatch: evaluation.matrix.mismatched.length > 0,
        });
      }
      candidates.push(...evaluation.candidates);
    }
    await this.saveRecon(reconRows);
    const result = await this.applyCandidates(candidates);
    result.checked = snapshots.length;
    return result;
  }

  /** One UPDATE … FROM (VALUES …) for the whole chunk. */
  private async saveRecon(rows: Array<{ paymentId: string; recon: ReconState; mismatch: boolean }>): Promise<void> {
    if (rows.length === 0) return;
    const values = sql.join(
      rows.map((r) => sql`(${r.paymentId}, ${JSON.stringify(r.recon)}::jsonb, ${r.mismatch}::boolean)`),
      sql`, `,
    );
    await this.db.execute(sql`
      update payments as p
      set recon = v.recon, mismatch = v.mismatch
      from (values ${values}) as v(id, recon, mismatch)
      where p.id = v.id`);
  }

  /** Re-checks settlement batches (rule D7). */
  async checkBatches(batchIds: readonly string[]): Promise<ReconciliationSummary> {
    const summary = emptySummary();
    for (const chunk of chunks([...new Set(batchIds)], RECON_CHUNK_SIZE)) {
      mergeSummary(summary, await this.checkBatchChunk(chunk));
    }
    return summary;
  }

  private async checkBatchChunk(batchIds: string[]): Promise<ReconciliationSummary> {
    const now = this.clock.now();
    const batches = await loadBatches(this.db, this.gateway, batchIds);
    const checks = batches.map((b) => ({ batch: b, result: checkBatch(b) }));

    // The case links to the first offending line's payment so the case page has a lifecycle.
    const offendingOrderIds = checks.flatMap(({ batch, result }) => {
      const gwId = result.hit ? result.offendingLines[0]?.line.gwPaymentId : undefined;
      const orderId = gwId ? batch.paymentsByGw.get(gwId)?.orderId : undefined;
      return orderId ? [orderId] : [];
    });
    const snapshots = await loadOrderSnapshots(this.db, this.gateway, offendingOrderIds, now);
    const snapshotByGw = new Map(snapshots.flatMap((s) => s.gateway.map((g) => [g.id, s] as const)));

    const candidates: CaseCandidate[] = [];
    for (const { batch, result } of checks) {
      await this.db
        .update(settlements)
        .set({
          expectedNetMinor: result.expectedNetMinor,
          reportedNetMinor: result.reportedNetMinor,
          status: result.diffMinor === 0 ? 'MATCHED' : 'MISMATCH',
        })
        .where(inArray(settlements.id, [batch.settlement.id]));
      if (!result.hit) continue;
      const gwId = result.offendingLines[0]?.line.gwPaymentId;
      const snapshot = gwId ? snapshotByGw.get(gwId) : undefined;
      const matrix = snapshot
        ? buildMatrix(snapshot)
        : blankMatrix({ SETTLEMENT: { status: 'NET MISMATCH', mismatch: true, detail: result.hit.reason } });
      const entityRefs = snapshot ? snapshotEntityRefs(snapshot) : { merchantId: batch.merchant.id };
      if (snapshot) entityRefs.gwPaymentId = gwId;
      candidates.push(...groupHits([result.hit], { entityRefs, matrix }));
    }
    const summary = await this.applyCandidates(candidates);
    summary.checked = batches.length;
    return summary;
  }

  /**
   * Periodic full check: every order and settlement batch from the last `sinceDays` days, in
   * chunks so memory stays flat.
   */
  async sweep(opts: { sinceDays?: number } = {}): Promise<ReconciliationSummary> {
    const since = new Date(this.clock.now().getTime() - (opts.sinceDays ?? 30) * DAY_MS);
    const summary = emptySummary();

    let afterId = '';
    for (;;) {
      const rows = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(and(gte(orders.createdAt, since), gt(orders.id, afterId)))
        .orderBy(asc(orders.id))
        .limit(RECON_CHUNK_SIZE);
      if (rows.length === 0) break;
      mergeSummary(summary, await this.checkOrderChunk(rows.map((r) => r.id)));
      afterId = rows[rows.length - 1]?.id ?? afterId;
      if (rows.length < RECON_CHUNK_SIZE) break;
    }

    afterId = '';
    for (;;) {
      const rows = await this.db
        .select({ id: settlements.id })
        .from(settlements)
        .where(and(gte(settlements.settledOn, since), gt(settlements.id, afterId)))
        .orderBy(asc(settlements.id))
        .limit(RECON_CHUNK_SIZE);
      if (rows.length === 0) break;
      mergeSummary(summary, await this.checkBatchChunk(rows.map((r) => r.id)));
      afterId = rows[rows.length - 1]?.id ?? afterId;
      if (rows.length < RECON_CHUNK_SIZE) break;
    }
    return summary;
  }

  private async applyCandidates(candidates: CaseCandidate[]): Promise<ReconciliationSummary> {
    const summary = emptySummary();
    const touched: Array<{ id: string; created: boolean }> = [];
    for (const candidate of candidates) {
      const result = await this.db.transaction((tx) => this.cases.openOrUpdate(candidate, tx));
      if (result.created) summary.opened += 1;
      else summary.updated += 1;
      if (result.changed) touched.push({ id: result.case.id, created: result.created });
    }
    // After commit: publish only what changed, so a sweep over stable data is silent.
    const items = await this.cases.listItems(touched.map((t) => t.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const t of touched) {
      const item = byId.get(t.id);
      if (!item) continue;
      summary.cases.push({ case: item, created: t.created });
      this.events.publish(ROOMS.ops, t.created ? OPS_EVENTS.caseCreated : OPS_EVENTS.caseUpdated, item);
    }
    return summary;
  }
}
