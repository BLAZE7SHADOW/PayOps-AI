import type { Severity } from './enums';

/**
 * Time an operator has to act on a case, by severity (D067). Wall-clock hours, not business
 * hours: payment problems do not wait for the weekend. Code computes due times and overdue
 * flags; models never do date math.
 */
export const SLA_HOURS: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 8,
  MEDIUM: 24,
  LOW: 72,
};

const HOUR_MS = 60 * 60 * 1000;

export function dueAtFor(severity: Severity, openedAt: Date): Date {
  return new Date(openedAt.getTime() + SLA_HOURS[severity] * HOUR_MS);
}

/** A case is overdue only while it is still open and its due time has passed. */
export function isOverdue(dueAt: Date | null, isOpen: boolean, now: Date): boolean {
  return isOpen && dueAt !== null && dueAt.getTime() < now.getTime();
}
