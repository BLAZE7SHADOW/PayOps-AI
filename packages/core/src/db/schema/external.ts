/**
 * External world: what the payment gateway / acquiring bank owns.
 * Only the gateway adapter and the simulator touch these tables (docs/02-architecture.md §3).
 */
import { check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CARD_NETWORKS,
  GW_PAYMENT_STATUS,
  GW_REFUND_STATUS,
  PAYMENT_METHODS,
  WEBHOOK_DELIVERY_STATUS,
  WEBHOOK_EVENT_TYPES,
  type CardNetwork,
} from '@payops/shared';
import { createdAt, money, tstz, updatedAt } from './_columns';

export interface CardInfo {
  last4: string;
  network: CardNetwork;
  country: string;
}

export const gwPayments = pgTable(
  'gw_payments',
  {
    id: text().primaryKey(),
    orderRef: text().notNull(),
    merchantId: text().notNull(),
    amountMinor: money().notNull(),
    currency: text().notNull().default('INR'),
    status: text({ enum: GW_PAYMENT_STATUS }).notNull(),
    method: text({ enum: PAYMENT_METHODS }).notNull(),
    card: jsonb().$type<CardInfo | null>(),
    capturedAt: tstz(),
    refundedMinor: money().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.orderRef),
    index().on(t.createdAt),
    check('gw_payments_amount_positive', sql`${t.amountMinor} > 0`),
  ],
);

export const gwRefunds = pgTable(
  'gw_refunds',
  {
    id: text().primaryKey(),
    gwPaymentId: text()
      .notNull()
      .references(() => gwPayments.id),
    amountMinor: money().notNull(),
    status: text({ enum: GW_REFUND_STATUS }).notNull(),
    processedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.gwPaymentId), check('gw_refunds_amount_positive', sql`${t.amountMinor} > 0`)],
);

export interface DeliveryAttempt {
  at: string; // ISO
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

export const gwWebhookDeliveries = pgTable(
  'gw_webhook_deliveries',
  {
    id: text().primaryKey(), // event id
    event: text({ enum: WEBHOOK_EVENT_TYPES }).notNull(),
    gwPaymentId: text()
      .notNull()
      .references(() => gwPayments.id),
    gwRefundId: text(),
    attempts: jsonb().$type<DeliveryAttempt[]>().notNull().default([]),
    finalStatus: text({ enum: WEBHOOK_DELIVERY_STATUS }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.gwPaymentId)],
);

export const gwSettlementLines = pgTable(
  'gw_settlement_lines',
  {
    id: text().primaryKey(),
    batchId: text().notNull(),
    merchantId: text().notNull(),
    gwPaymentId: text()
      .notNull()
      .references(() => gwPayments.id),
    grossMinor: money().notNull(),
    feeMinor: money().notNull(),
    taxMinor: money().notNull(),
    netMinor: money().notNull(),
    lineNo: integer().notNull(),
    settledOn: tstz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.batchId), index().on(t.gwPaymentId)],
);
