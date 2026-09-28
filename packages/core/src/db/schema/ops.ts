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

