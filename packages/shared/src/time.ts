export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Coarse age label for dense UIs: "4m", "3h", "9d". */
export function ageLabel(fromIso: string | Date, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (ms < MINUTE_MS) return 'now';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/**
 * Due label for dense UIs: "in 3h" while time remains, "2h late" once past, "due now" inside a
 * minute either way. Uses the same coarse units as `ageLabel`.
 */
export function dueLabel(dueIso: string | Date, now: Date = new Date()): string {
  const ms = new Date(dueIso).getTime() - now.getTime();
  const abs = Math.abs(ms);
  if (abs < MINUTE_MS) return 'due now';
  const span = ageLabel(new Date(now.getTime() - abs), now);
  return ms > 0 ? `in ${span}` : `${span} late`;
}
