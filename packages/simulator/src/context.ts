import { bpsOf, type IdGenerator } from '@payops/shared';
import { tables, type Tx } from '@payops/core';
import type { World, WorldMerchant } from './world';

/** A gateway settlement line waiting to be grouped into a batch. */
interface PendingLine {
  group: string;
  merchant: WorldMerchant;
  gwPaymentId: string;
  paymentId: string | null;
  grossMinor: number;
  capturedAt: Date;
  feeBps: number;
}

/**
 * Shared state while one scenario is written: the transaction, the seeded id generator, the
 * clock's "now", and what has been created so far (returned to the caller and re-checked).
 */
export class ScenarioContext {
  readonly created = { paymentIds: [] as string[], orderIds: [] as string[], batchIds: [] as string[] };
  private readonly pendingLines: PendingLine[] = [];

  constructor(
    readonly tx: Tx,
    readonly ids: IdGenerator,
    readonly now: Date,
    readonly world: World,
  ) {}

  queueSettlement(line: PendingLine): void {
    this.pendingLines.push(line);
  }

  /**
   * Writes the gateway settlement file (one batch per group + merchant) and our internal
   * settlement record. The gateway settles T+1 after the last capture in the batch.
   */
  async flushSettlements(): Promise<void> {
    const groups = new Map<string, PendingLine[]>();
    for (const line of this.pendingLines) {
      const key = `${line.group}|${line.merchant.id}`;
      const list = groups.get(key);
      if (list) list.push(line);
      else groups.set(key, [line]);
    }
    this.pendingLines.length = 0;

    for (const lines of groups.values()) {
      const merchant = (lines[0] as PendingLine).merchant;
      const batchId = this.ids.next('settlementBatch');
      const lastCapture = Math.max(...lines.map((l) => l.capturedAt.getTime()));
      const settledOn = new Date(lastCapture + merchantCycleMs);
      let expectedNetMinor = 0;
      let reportedNetMinor = 0;
      const rows = lines.map((l, i) => {
        const charged = feeFor(l.grossMinor, l.feeBps, merchant);
        expectedNetMinor += feeFor(l.grossMinor, merchant.feeBps, merchant).netMinor;
        reportedNetMinor += charged.netMinor;
        return {
          id: this.ids.next('settlementLine'),
          batchId,
          merchantId: merchant.id,
          gwPaymentId: l.gwPaymentId,
          grossMinor: l.grossMinor,
          feeMinor: charged.feeMinor,
          taxMinor: charged.taxMinor,
          netMinor: charged.netMinor,
          lineNo: i + 1,
          settledOn,
          createdAt: settledOn,
        };
      });
      await this.tx.insert(tables.gwSettlementLines).values(rows);
      await this.tx.insert(tables.settlements).values({
        id: batchId,
        merchantId: merchant.id,
        settledOn,
        paymentIds: lines.map((l) => l.paymentId).filter((p): p is string => p !== null),
        expectedNetMinor,
        reportedNetMinor,
        status: 'PENDING',
        createdAt: settledOn,
        updatedAt: settledOn,
      });
      this.created.batchIds.push(batchId);
    }
  }
}

/** Settlement cycle is T+1 for every demo merchant. */
export const merchantCycleMs = 24 * 60 * 60 * 1000;

function feeFor(grossMinor: number, feeBps: number, merchant: WorldMerchant) {
  const feeMinor = bpsOf(grossMinor, feeBps) + merchant.feeFixedMinor;
  const taxMinor = bpsOf(feeMinor, merchant.taxBps);
  return { feeMinor, taxMinor, netMinor: grossMinor - feeMinor - taxMinor };
}
