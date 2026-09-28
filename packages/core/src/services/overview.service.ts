import { and, asc, count, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  CASE_TYPES,
  DAY_MS,
  OPEN_CASE_STATUSES,
  type CaseType,
  type OverviewMetrics,
} from '@payops/shared';
import type { Db } from '../db/client';
import { cases, users } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import { toCaseListItem } from './case.service';

const TREND_DAYS = 14;

/** Start of the UTC day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export class OverviewService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
  ) {}

  async metrics(): Promise<OverviewMetrics> {
    const now = this.clock.now();
    const today = startOfUtcDay(now);
    const trendStart = new Date(today.getTime() - (TREND_DAYS - 1) * DAY_MS);
    const day = sql<string>`to_char(${cases.openedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

    const [captured, openRows, resolvedRows, trendRows, oldest] = await Promise.all([
      this.gateway.summarizeCaptures({ from: today, to: new Date(today.getTime() + DAY_MS) }),
      this.db
        .select({ status: cases.status, n: count() })
        .from(cases)
        .where(inArray(cases.status, [...OPEN_CASE_STATUSES]))
        .groupBy(cases.status),
      this.db
        .select({ n: count() })
        .from(cases)
        .where(and(eq(cases.status, 'RESOLVED'), gte(cases.resolvedAt, new Date(now.getTime() - 7 * DAY_MS)))),
      this.db
        .select({ day, type: cases.type, n: count() })
        .from(cases)
        .where(gte(cases.openedAt, trendStart))
        .groupBy(day, cases.type),
      this.db
        .select({ row: cases, assigneeName: users.name })
        .from(cases)
        .leftJoin(users, eq(users.id, cases.assigneeId))
        .where(inArray(cases.status, [...OPEN_CASE_STATUSES]))
        .orderBy(asc(cases.openedAt), asc(cases.id))
        .limit(5),
    ]);

    const byDay = new Map<string, Partial<Record<CaseType, number>>>();
    for (let i = 0; i < TREND_DAYS; i++) {
      byDay.set(new Date(trendStart.getTime() + i * DAY_MS).toISOString().slice(0, 10), {});
    }
    for (const r of trendRows) {
      const bucket = byDay.get(r.day);
      if (bucket && (CASE_TYPES as readonly string[]).includes(r.type)) bucket[r.type] = r.n;
    }

    return {
      capturedTodayMinor: captured.amountMinor,
      capturedTodayCount: captured.count,
      openExceptions: openRows.reduce((acc, r) => acc + r.n, 0),
      awaitingApproval: openRows.find((r) => r.status === 'AWAITING_APPROVAL')?.n ?? 0,
      resolved7d: resolvedRows[0]?.n ?? 0,
      resolvedByAgent7d: 0, // Phase 3: agent resolutions
      exceptionsByType: [...byDay.entries()].map(([date, counts]) => ({ date, ...counts })),
      oldestOpen: oldest.map((r) => toCaseListItem(r.row, r.assigneeName)),
    };
  }
}
