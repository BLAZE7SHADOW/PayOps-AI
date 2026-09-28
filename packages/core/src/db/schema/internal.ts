/** Internal world: the systems we own (docs/04-data-model.md). */
import { boolean, check, index, integer, jsonb, pgTable, real, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  INTERNAL_PAYMENT_STATUS,
  LEDGER_ACCOUNTS,
  LEDGER_DIRECTIONS,
  LEDGER_SOURCES,
  NOTE_AUTHOR_TYPES,
  ORDER_STATUS,
  REFUND_STATUS,
  SETTLEMENT_STATUS,
  type OrderStatus,
  type SystemKey,
} from '@payops/shared';
import { createdAt, money, tstz, updatedAt } from './_columns';

export const merchants = pgTable('merchants', {
  id: text().primaryKey(),
  name: text().notNull(),
  /** Contracted fee in basis points (200 = 2.00%) plus a fixed fee, and GST on the fee. */
  feeBps: integer().notNull(),
  feeFixedMinor: money().notNull().default(0),
  taxBps: integer().notNull().default(1800),
  settlementCycleDays: integer().notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable('customers', {
  id: text().primaryKey(),
  name: text().notNull(),
  emailMasked: text().notNull(),
  phoneMasked: text().notNull(),
  riskFlags: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const devices = pgTable(
  'devices',
  {
    id: text().primaryKey(),
    customerId: text()
      .notNull()
      .references(() => customers.id),
    fingerprint: text().notNull(),
    ipCountry: text().notNull(),
    firstSeenAt: tstz().notNull(),
  },
  (t) => [index().on(t.customerId)],
);

export interface OrderTransition {
  at: string; // ISO
  from: OrderStatus | null;
  to: OrderStatus;
  by: string; // 'checkout' | 'webhook-consumer' | 'merchant' | 'ops:<userId>' | 'executor'
  reason: string | null;
}

export const orders = pgTable(
  'orders',
  {
    id: text().primaryKey(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id),
    customerId: text()
      .notNull()
      .references(() => customers.id),
    amountMinor: money().notNull(),
    status: text({ enum: ORDER_STATUS }).notNull(),
    paymentId: text(),
    /** Optimistic concurrency token; every transition must match and increment it. */
    version: integer().notNull().default(0),
    /** Simulator fault injection: webhook-driven transitions are rejected while set. */
    lockedReason: text(),
    timeline: jsonb().$type<OrderTransition[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.status),
    index().on(t.customerId),
    index().on(t.createdAt),
    check('orders_amount_positive', sql`${t.amountMinor} > 0`),
  ],
);

/** Result of the last reconciliation check, denormalised for filtering and list views. */
export interface ReconState {
  mismatched: SystemKey[];
  checkedAt: string;
}

export const payments = pgTable(
  'payments',
  {
    id: text().primaryKey(),
    gwPaymentId: text().notNull().unique(),
    orderId: text()
      .notNull()
      .references(() => orders.id),
    merchantId: text()
      .notNull()
      .references(() => merchants.id),
    customerId: text()
      .notNull()
      .references(() => customers.id),
    amountMinor: money().notNull(),
    method: text().notNull(),
    status: text({ enum: INTERNAL_PAYMENT_STATUS }).notNull(),
    hold: boolean().notNull().default(false),
    recon: jsonb().$type<ReconState | null>(),
    mismatch: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.orderId),
    index().on(t.customerId),
    index().on(t.createdAt, t.id),
    index().on(t.mismatch, t.createdAt),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: text().primaryKey(),
    customerId: text()
      .notNull()
      .references(() => customers.id),
    deviceId: text().notNull(),
    orderId: text(),
    amountMinor: money().notNull(),
    result: text({ enum: ['SUCCESS', 'FAILED'] }).notNull(),
    failureCode: text(),
    cardCountry: text(),
    at: tstz().notNull(),
  },
  (t) => [index().on(t.customerId, t.at)],
);

export const refunds = pgTable(
  'refunds',
  {
    id: text().primaryKey(),
    paymentId: text()
      .notNull()
      .references(() => payments.id),
    gwRefundId: text(),
    amountMinor: money().notNull(),
    status: text({ enum: REFUND_STATUS }).notNull(),
    reason: text().notNull(),
    requestedAt: tstz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.paymentId), index().on(t.status), check('refunds_amount_positive', sql`${t.amountMinor} > 0`)],
);

/**
 * Double-entry ledger, append-only. Corrections are new rows with `reversalOf` set.
 * Capture:  DEBIT SETTLEMENT_CLEARING / CREDIT MERCHANT_PAYABLE
 * Refund:   DEBIT MERCHANT_PAYABLE    / CREDIT SETTLEMENT_CLEARING
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text().primaryKey(),
    /** Groups the legs of one posting. */
    journalId: text().notNull(),
    paymentId: text(),
    refundId: text(),
    batchId: text(),
    merchantId: text().notNull(),
    account: text({ enum: LEDGER_ACCOUNTS }).notNull(),
    direction: text({ enum: LEDGER_DIRECTIONS }).notNull(),
    amountMinor: money().notNull(),
    postedAt: tstz().notNull(),
    source: text({ enum: LEDGER_SOURCES }).notNull(),
    memo: text().notNull(),
    reversalOf: text(),
  },
  (t) => [
    index().on(t.paymentId),
    index().on(t.refundId),
    index().on(t.journalId),
    check('ledger_amount_positive', sql`${t.amountMinor} > 0`),
  ],
);

export const settlements = pgTable(
  'settlements',
  {
    id: text().primaryKey(), // batch id
    merchantId: text()
      .notNull()
      .references(() => merchants.id),
    settledOn: tstz().notNull(),
    paymentIds: jsonb().$type<string[]>().notNull().default([]),
    expectedNetMinor: money().notNull(),
    reportedNetMinor: money().notNull(),
    status: text({ enum: SETTLEMENT_STATUS }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.merchantId, t.settledOn)],
);

export const supportNotes = pgTable(
  'support_notes',
  {
    id: text().primaryKey(),
    paymentId: text(),
    orderId: text(),
    authorType: text({ enum: NOTE_AUTHOR_TYPES }).notNull(),
    /** Untrusted free text. Rendered as plain text only; screened before any model sees it. */
    text: text().notNull(),
    complaintType: text(),
    urgent: boolean(),
    injectionProbability: real(),
    quarantined: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.paymentId), index().on(t.orderId)],
);
