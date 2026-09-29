/**
 * Shift handoff summary (P2 task 2, D068). Everything here is counted and ordered by code from
 * the database; no model writes or rewords any of it (CLAUDE.md rule 4). The web app turns the
 * result into text with `renderHandoffText` from shared.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  OPEN_CASE_STATUSES,
  SEVERITIES,
  isOverdue,
  type ActorType,
  type HandoffCaseRef,
  type HandoffSummary,
  type Severity,
} from '@payops/shared';
import type { Db } from '../db/client';
import { caseNotes, cases, users } from '../db/schema';
import type { ClockPort } from '../ports/clock';

const MAX_ATTENTION = 10;
const MAX_RECENT_NOTES = 10;

export class HandoffService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
  ) {}

  async summary(sinceHours: number): Promise<HandoffSummary> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - sinceHours * 3_600_000);

    const openRows = await this.db
      .select({ row: cases, assigneeName: users.name })
      .from(cases)
      .leftJoin(users, eq(users.id, cases.assigneeId))
      .where(inArray(cases.status, [...OPEN_CASE_STATUSES]));

    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    let overdue = 0;
    let awaitingApproval = 0;
    let unassigned = 0;
    const attention: Array<{ ref: Omit<HandoffCaseRef, 'lastNote'>; priority: number; openedAt: number }> = [];

    for (const { row, assigneeName } of openRows) {
      bySeverity[row.severity] += 1;
      const isLate = isOverdue(row.dueAt, true, now);
      if (isLate) overdue += 1;
      if (row.status === 'AWAITING_APPROVAL') awaitingApproval += 1;
      if (!row.assigneeId) unassigned += 1;

      const reasons: string[] = [];
      if (isLate) reasons.push('Overdue');
      if (row.severity === 'CRITICAL') reasons.push('Critical');
      if (row.status === 'AWAITING_APPROVAL') reasons.push('Waiting for approval');
      if (row.status === 'ESCALATED') reasons.push('Escalated');
      if (reasons.length === 0) continue;
      attention.push({
        priority: row.priority,
        openedAt: row.openedAt.getTime(),
        ref: {
          id: row.id,
          displayId: row.displayId,
          type: row.type,
          severity: row.severity,
          status: row.status,
          amountMinor: row.amountMinor,
          dueAt: row.dueAt ? row.dueAt.toISOString() : null,
          overdue: isLate,
          assigneeName: assigneeName ?? null,
          reasons,
        },
      });
    }
    // Same order as the queue: priority high to low, then oldest first.
    attention.sort((a, b) => b.priority - a.priority || a.openedAt - b.openedAt);
    const top = attention.slice(0, MAX_ATTENTION);

    // Newest note per listed case.
    const lastNotes = new Map<string, HandoffCaseRef['lastNote']>();
    if (top.length > 0) {
      const notes = await this.db
        .select()
        .from(caseNotes)
        .where(inArray(caseNotes.caseId, top.map((a) => a.ref.id)))
        .orderBy(desc(caseNotes.createdAt), desc(caseNotes.id));
      for (const n of notes) {
        if (!lastNotes.has(n.caseId)) lastNotes.set(n.caseId, { text: n.text, authorName: n.authorName, at: n.createdAt.toISOString() });
      }
    }

    const resolvedRows = await this.db
      .select({ resolution: cases.resolution })
      .from(cases)
      .where(and(eq(cases.status, 'RESOLVED'), gte(cases.resolvedAt, since)));
    const resolvedBy = Object.fromEntries(ACTOR_TYPES.map((a) => [a, 0])) as Record<ActorType, number>;
    for (const r of resolvedRows) if (r.resolution) resolvedBy[r.resolution.by] += 1;

    const recent = await this.db
      .select({ note: caseNotes, displayId: cases.displayId })
      .from(caseNotes)
      .innerJoin(cases, eq(cases.id, caseNotes.caseId))
      .where(gte(caseNotes.createdAt, since))
      .orderBy(desc(caseNotes.createdAt), desc(caseNotes.id))
      .limit(MAX_RECENT_NOTES);

    return {
      generatedAt: now.toISOString(),
      sinceHours,
      since: since.toISOString(),
      open: { total: openRows.length, overdue, awaitingApproval, unassigned, bySeverity },
      needsAttention: top.map((a) => ({ ...a.ref, lastNote: lastNotes.get(a.ref.id) ?? null })),
      resolved: { total: resolvedRows.length, by: resolvedBy },
      recentNotes: recent.map(({ note, displayId }) => ({
        caseId: note.caseId,
        displayId,
        text: note.text,
        authorName: note.authorName,
        at: note.createdAt.toISOString(),
      })),
    };
  }
}
