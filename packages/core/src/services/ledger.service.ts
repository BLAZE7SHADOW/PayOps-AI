/**
 * Double-entry ledger writes. The ledger is append-only: corrections are new journals whose legs
 * point at the originals through `reversalOf`.
 *
 *   Capture:  DEBIT SETTLEMENT_CLEARING / CREDIT MERCHANT_PAYABLE
 *   Refund:   DEBIT MERCHANT_PAYABLE    / CREDIT SETTLEMENT_CLEARING
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { formatMoney, newId, type LedgerAccount, type LedgerSource } from '@payops/shared';
import type { DbOrTx, Tx } from '../db/client';
import type { LedgerEntryRow } from '../db/rows';
import { ledgerEntries, payments } from '../db/schema';
import { AppError, notFound } from '../errors';
import { captureCreditMinor } from '../reconciliation/facts';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';

export interface JournalSummary {
  journalId: string;
  kind: 'CAPTURE' | 'REFUND' | 'REVERSAL';
  amountMinor: number;
  postedAt: Date;
  source: LedgerSource;
  memo: string;
  legs: LedgerEntryRow[];
  /** Journal that reversed this one, if any. */
  reversedBy: string | null;
}

/** Groups ledger rows into journals (oldest first) and marks which ones were reversed. */
export function summarizeJournals(entries: readonly LedgerEntryRow[]): JournalSummary[] {
  const byJournal = new Map<string, LedgerEntryRow[]>();
  for (const e of [...entries].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.id.localeCompare(b.id))) {
    const legs = byJournal.get(e.journalId);
    if (legs) legs.push(e);
    else byJournal.set(e.journalId, [e]);
  }
  const reversedBy = new Map<string, string>();
  for (const e of entries) if (e.reversalOf) reversedBy.set(e.reversalOf, e.journalId);
  return [...byJournal.entries()].map(([journalId, legs]) => {
    const first = legs[0] as LedgerEntryRow;
    const kind = first.reversalOf ? 'REVERSAL' : first.refundId ? 'REFUND' : 'CAPTURE';
    const reverser = legs.map((l) => reversedBy.get(l.id)).find((j) => j !== undefined) ?? null;
    return {
      journalId,
      kind,
      amountMinor: first.amountMinor,
      postedAt: first.postedAt,
      source: first.source,
      memo: first.memo,
      legs,
      reversedBy: reverser,
    };
  });
}

/** Capture journals for a payment that are still in force (posted and not reversed). */
export function liveCaptureJournals(entries: readonly LedgerEntryRow[]): JournalSummary[] {
  return summarizeJournals(entries).filter((j) => j.kind === 'CAPTURE' && j.reversedBy === null);
}

export class LedgerService {
  constructor(
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  /** Every ledger row of a payment (capture and refund journals), oldest first. */
  async entriesForPayment(db: DbOrTx, paymentId: string): Promise<LedgerEntryRow[]> {
    return db.select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, paymentId)).orderBy(asc(ledgerEntries.postedAt), asc(ledgerEntries.id));
  }

  async journalsForPayment(db: DbOrTx, paymentId: string): Promise<JournalSummary[]> {
    return summarizeJournals(await this.entriesForPayment(db, paymentId));
  }

  /**
   * Posts the capture journal for a payment. Refuses if a capture credit is already in force, so
   * a retried or duplicated call can never double-post. Locks the payment row to serialise.
   */
  async postCapture(
    tx: Tx,
    input: { paymentId: string; merchantId: string; amountMinor: number; source: LedgerSource; memo?: string },
    ctx: WriteContext,
  ): Promise<string> {
    const [payment] = await tx.select({ id: payments.id, gwPaymentId: payments.gwPaymentId }).from(payments).where(eq(payments.id, input.paymentId)).for('update');
    if (!payment) throw notFound('Payment', input.paymentId);
    const existing = captureCreditMinor({ ledger: await this.entriesForPayment(tx, input.paymentId) });
    if (existing > 0) {
      throw new AppError('CONFLICT', `Payment ${input.paymentId} already has a capture credit of ${formatMoney(existing)}`);
    }
    const journalId = await this.insertJournal(tx, {
      paymentId: input.paymentId,
      refundId: null,
      merchantId: input.merchantId,
      amountMinor: input.amountMinor,
      debit: 'SETTLEMENT_CLEARING',
      credit: 'MERCHANT_PAYABLE',
      source: input.source,
      memo: input.memo ?? `Capture ${payment.gwPaymentId}`,
    });
    await this.audit.record(
      auditFrom(ctx, {
        action: 'ledger.posted',
        entityType: 'payment',
        entityId: input.paymentId,
        summary: `Posted capture journal ${journalId} for ${formatMoney(input.amountMinor)}: debit settlement clearing, credit merchant payable`,
        after: { journalId, amountMinor: input.amountMinor, source: input.source },
      }),
      tx,
    );
    return journalId;
  }

  /** Posts the refund journal for a refund. Refuses if one is already in force for that refund. */
  async postRefund(
    tx: Tx,
    input: { refundId: string; paymentId: string | null; gwPaymentId: string; merchantId: string; amountMinor: number; source: LedgerSource },
    ctx: WriteContext,
  ): Promise<string> {
    if (await this.hasLiveRefundJournal(tx, input.refundId)) {
      throw new AppError('CONFLICT', `Refund ${input.refundId} is already posted to the ledger`);
    }
    const journalId = await this.insertJournal(tx, {
      paymentId: input.paymentId,
      refundId: input.refundId,
      merchantId: input.merchantId,
      amountMinor: input.amountMinor,
      debit: 'MERCHANT_PAYABLE',
      credit: 'SETTLEMENT_CLEARING',
      source: input.source,
      memo: `Refund ${input.refundId} on ${input.gwPaymentId}`,
    });
    await this.audit.record(
      auditFrom(ctx, {
        action: 'ledger.posted',
        entityType: 'refund',
        entityId: input.refundId,
        summary: `Posted refund journal ${journalId} for ${formatMoney(input.amountMinor)} on ${input.gwPaymentId}`,
        after: { journalId, amountMinor: input.amountMinor, paymentId: input.paymentId, gwPaymentId: input.gwPaymentId },
      }),
      tx,
    );
    return journalId;
  }

  async hasLiveRefundJournal(db: DbOrTx, refundId: string): Promise<boolean> {
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refundId, refundId));
    return summarizeJournals(rows).some((j) => j.kind === 'REFUND' && j.reversedBy === null);
  }

  /** Posts equal and opposite legs. The original stays; a journal can be reversed only once. */
  async reverseJournal(tx: Tx, journalId: string, source: LedgerSource, ctx: WriteContext): Promise<string> {
    const legs = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.journalId, journalId)).for('update');
    if (legs.length === 0) throw notFound('Journal', journalId);
    if (legs.some((l) => l.reversalOf !== null)) {
      throw new AppError('CONFLICT', `Journal ${journalId} is itself a reversal and cannot be reversed`);
    }
    const already = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(isNotNull(ledgerEntries.reversalOf), inArray(ledgerEntries.reversalOf, legs.map((l) => l.id))))
      .limit(1);
    if (already.length > 0) throw new AppError('CONFLICT', `Journal ${journalId} was already reversed`);

    const reversalId = newId('journal');
    const postedAt = this.clock.now();
    await tx.insert(ledgerEntries).values(
      legs.map((l) => ({
        id: newId('ledgerEntry'),
        journalId: reversalId,
        paymentId: l.paymentId,
        refundId: l.refundId,
        batchId: l.batchId,
        merchantId: l.merchantId,
        account: l.account,
        direction: l.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
        amountMinor: l.amountMinor,
        postedAt,
        source,
        memo: `Reversal of ${journalId}`,
        reversalOf: l.id,
      })),
    );
    const first = legs[0] as LedgerEntryRow;
    await this.audit.record(
      auditFrom(ctx, {
        action: 'ledger.reversed',
        entityType: first.paymentId ? 'payment' : 'refund',
        entityId: first.paymentId ?? first.refundId ?? journalId,
        summary: `Reversed journal ${journalId} (${formatMoney(first.amountMinor)}) with ${reversalId}`,
        after: { journalId: reversalId, reversalOf: journalId },
      }),
      tx,
    );
    return reversalId;
  }

  private async insertJournal(
    tx: Tx,
    j: {
      paymentId: string | null;
      refundId: string | null;
      merchantId: string;
      amountMinor: number;
      debit: LedgerAccount;
      credit: LedgerAccount;
      source: LedgerSource;
      memo: string;
    },
  ): Promise<string> {
    if (!Number.isSafeInteger(j.amountMinor) || j.amountMinor <= 0) {
      throw new AppError('BAD_REQUEST', `Ledger amount must be a positive number of paise, got ${j.amountMinor}`);
    }
    const journalId = newId('journal');
    const base = {
      journalId,
      paymentId: j.paymentId,
      refundId: j.refundId,
      merchantId: j.merchantId,
      amountMinor: j.amountMinor,
      postedAt: this.clock.now(),
      source: j.source,
      memo: j.memo,
    };
    await tx.insert(ledgerEntries).values([
      { ...base, id: newId('ledgerEntry'), account: j.debit, direction: 'DEBIT' },
      { ...base, id: newId('ledgerEntry'), account: j.credit, direction: 'CREDIT' },
    ]);
    return journalId;
  }
}
