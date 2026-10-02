import { and, asc, count, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  CASE_TYPES,
  DAY_MS,
  OPEN_CASE_STATUSES,
  type CaseType,
  type OverviewMetrics,
  type ValidationVerdict,
} from '@payops/shared';
import type { Db } from '../db/client';
import { agentRuns, approvals, cases, diagnosisFeedback, users, validationResults } from '../db/schema';
import { computePerformance } from '../metrics/performance';
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
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const trendStart = new Date(today.getTime() - (TREND_DAYS - 1) * DAY_MS);
    const day = sql<string>`to_char(${cases.openedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

    const [captured, openRows, resolvedRows, trendRows, oldest, pending, agentResolved, verdictRows, perfCases, perfApprovals, perfFeedback, perfRuns] = await Promise.all([
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
      this.db.select({ n: count() }).from(approvals).where(eq(approvals.status, 'PENDING')),
      this.db.select({ n: count() }).from(cases).where(and(
        eq(cases.status, 'RESOLVED'), gte(cases.resolvedAt, new Date(now.getTime() - 7 * DAY_MS)),
        sql`${cases.resolution}->>'by' = 'AGENT'`,
      )),
      this.db
        .select({ verdict: validationResults.verdict, n: count() })
        .from(validationResults)
        .where(gte(validationResults.at, new Date(now.getTime() - 7 * DAY_MS)))
        .groupBy(validationResults.verdict),
      this.db
        .select({ openedAt: cases.openedAt, resolvedAt: cases.resolvedAt, resolution: cases.resolution })
        .from(cases)
        .where(and(eq(cases.status, 'RESOLVED'), isNotNull(cases.resolvedAt), gte(cases.resolvedAt, since7d))),
      this.db
        .select({ requestedAt: approvals.requestedAt, decidedAt: approvals.decidedAt })
        .from(approvals)
        .where(and(isNotNull(approvals.decidedAt), gte(approvals.decidedAt, since7d))),
      this.db.select({ verdict: diagnosisFeedback.verdict }).from(diagnosisFeedback).where(gte(diagnosisFeedback.updatedAt, since7d)),
      this.db.select({ caseId: agentRuns.caseId, budget: agentRuns.budget }).from(agentRuns).where(gte(agentRuns.createdAt, since7d)),
    ]);

    const performance = computePerformance({
      resolved: perfCases.flatMap((c) =>
        c.resolvedAt ? [{ openedAt: c.openedAt, resolvedAt: c.resolvedAt, resolvedBy: c.resolution?.by ?? null }] : [],
      ),
      approvals: perfApprovals.flatMap((a) => (a.decidedAt ? [{ requestedAt: a.requestedAt, decidedAt: a.decidedAt }] : [])),
      feedback: perfFeedback,
      runs: perfRuns.map((r) => ({ caseId: r.caseId, costUsd: r.budget.costUsd })),
    });

    const validatorOutcomes7d: Record<ValidationVerdict, number> = { PASS: 0, PARTIAL: 0, FAIL: 0 };
    for (const r of verdictRows) validatorOutcomes7d[r.verdict] = r.n;

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
      awaitingApproval: pending[0]?.n ?? 0,
      resolved7d: resolvedRows[0]?.n ?? 0,
      resolvedByAgent7d: agentResolved[0]?.n ?? 0,
      validatorOutcomes7d,
      exceptionsByType: [...byDay.entries()].map(([date, counts]) => ({ date, ...counts })),
      performance,
      oldestOpen: oldest.map((r) => toCaseListItem(r.row, r.assigneeName, now)),
    };
  }
}
