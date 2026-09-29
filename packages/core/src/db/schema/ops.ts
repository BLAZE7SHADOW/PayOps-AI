/** Operations tables: users, cases, audit. Resolution tables live in resolution.ts. */
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  CASE_STATUS,
  CASE_TYPES,
  ROLES,
  SEVERITIES,
  type ActorType,
  type ComplaintType,
  type DetectionRuleId,
  type MatrixCell,
  type SavedViewFilters,
  type WebhookEventType,
  type WebhookLogAttempt,
  type WebhookLogStatus,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_LOG_STATUS,
  type SystemKey,
} from '@payops/shared';
import { createdAt, money, tstz, updatedAt } from './_columns';

export const users = pgTable('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  role: text({ enum: ROLES }).notNull(),
  passwordHash: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface CaseEntityRefs {
  paymentId?: string;
  gwPaymentId?: string;
  duplicateGwPaymentIds?: string[];
  orderId?: string;
  customerId?: string;
  merchantId?: string;
  refundId?: string;
  batchId?: string;
}

export interface CaseSignalsRow {
  complaintType?: ComplaintType | null;
  urgent?: boolean | null;
  quarantined?: boolean | null;
}

export interface CaseResolutionRow {
  by: ActorType;
  summary: string;
  runId: string | null;
}

export type StoredMatrix = Record<SystemKey, MatrixCell>;

export const cases = pgTable(
  'cases',
  {
    id: text().primaryKey(),
    displayId: text().notNull().unique(),
    /** `${caseType}:${primaryEntityId}`. At most one open case per fingerprint (partial unique index). */
    fingerprint: text().notNull(),
    type: text({ enum: CASE_TYPES }).notNull(),
    severity: text({ enum: SEVERITIES }).notNull(),
    priority: integer().notNull(),
    status: text({ enum: CASE_STATUS }).notNull(),
    amountMinor: money().notNull(),
    ruleIds: jsonb().$type<DetectionRuleId[]>().notNull(),
    matrix: jsonb().$type<StoredMatrix>().notNull(),
    mismatched: jsonb().$type<SystemKey[]>().notNull().default([]),
    entityRefs: jsonb().$type<CaseEntityRefs>().notNull(),
    signals: jsonb().$type<CaseSignalsRow>().notNull().default({}),
    assigneeId: text().references(() => users.id),
    /** Set once when the case opens: openedAt plus the severity window (shared/sla.ts, D067). */
    dueAt: tstz(),
    activeRunId: text(),
    resolution: jsonb().$type<CaseResolutionRow | null>(),
    lastDetectedAt: tstz().notNull(),
    openedAt: tstz().notNull(),
    resolvedAt: tstz(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cases_open_fingerprint_uq')
      .on(t.fingerprint)
      .where(sql`${t.status} not in ('RESOLVED', 'REJECTED')`),
    index().on(t.status, t.priority, t.openedAt),
    index().on(t.type),
    index('cases_payment_ref_idx').on(sql`(${t.entityRefs} ->> 'paymentId')`),
  ],
);

/** Monotonic counters, e.g. case display id sequence per prefix. */
export const counters = pgTable('counters', {
  id: text().primaryKey(),
  seq: integer().notNull(),
});

/** Append-only audit trail. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: text().primaryKey(),
    at: tstz().notNull().defaultNow(),
    actorType: text({ enum: ACTOR_TYPES }).notNull(),
    actorId: text().notNull(),
    actorName: text().notNull(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    summary: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    runId: text(),
    caseId: text(),
  },
  (t) => [index().on(t.at), index().on(t.entityId), index().on(t.caseId)],
);


/** Notes operators write on a case (P2 task 2, D068). Append-only: no edit, no delete. */
export const caseNotes = pgTable(
  'case_notes',
  {
    id: text().primaryKey(),
    caseId: text()
      .notNull()
      .references(() => cases.id),
    text: text().notNull(),
    authorId: text().notNull(),
    authorName: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.caseId, t.createdAt), index().on(t.createdAt)],
);

/** A user's named queue filters (P2 task 2, D068). Private to the owner. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: text().primaryKey(),
    ownerId: text()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    filters: jsonb().$type<SavedViewFilters>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.ownerId, t.name)],
);

/**
 * Our own record of every webhook event the consumer received (P3 task 2, D072). One row per
 * gateway event id; each delivery, retry or replay appends to `attempts`. `payload` is the event
 * as received, so a replay still works if the gateway cannot resend it.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text().primaryKey(), // gateway event id
    event: text({ enum: WEBHOOK_EVENT_TYPES }).notNull(),
    gwPaymentId: text().notNull(),
    gwRefundId: text(),
    payload: jsonb().$type<{ id: string; event: WebhookEventType; gwPaymentId: string; gwRefundId: string | null; createdAt: string }>().notNull(),
    status: text({ enum: WEBHOOK_LOG_STATUS }).notNull().$type<WebhookLogStatus>(),
    attempts: jsonb().$type<WebhookLogAttempt[]>().notNull().default([]),
    attemptCount: integer().notNull().default(0),
    lastHttpStatus: integer(),
    lastMessage: text().notNull().default(''),
    nextRetryAt: tstz(),
    firstReceivedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.status, t.updatedAt), index().on(t.gwPaymentId), index().on(t.updatedAt)],
);
