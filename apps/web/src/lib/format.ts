import { ageLabel, formatMoney, formatMoneyCompact } from '@payops/shared';

export { ageLabel, formatMoney, formatMoneyCompact };

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 12:31:04 (local time). */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 28 Sep 12:31:04 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${formatTime(iso)}`;
}

/** 28 Sep 2026, 12:31:04. Used in tooltips where the full timestamp matters. */
export function formatFullDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${formatTime(iso)}`;
}

/** 14 Sep, from a YYYY-MM-DD date (treated as a calendar date, no timezone shift). */
export function formatDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d ?? ''} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
}

/** Status codes are shown as mono uppercase with spaces: AWAITING_APPROVAL → AWAITING APPROVAL. */
export function statusLabel(code: string): string {
  return code.replace(/_/g, ' ').toUpperCase();
}

export function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** 92%, or 87.5% when the extra precision is real. One decimal max, trailing .0 dropped -- same
 * plain-number style as formatMoney/formatDateTime, never a raw float in the UI. */
export function formatConfidence(fraction: number): string {
  const pct = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/**
 * One line per Jev answer for the investigation trace (docs/05 §11 case screen mockup: "plan ·
 * primary: webhook_or_state_sync · conf 0.82"), e.g. "root_cause: WEBHOOK_PROCESSING_FAILURE
 * (92%)", "evidence_consistent: 87%", "velocity_abuse: 2 (81%)". `answer` is untyped
 * (`AgentStepItem.payload` is `Record<string, unknown>`), shaped like @typesafe-ai/sdk's
 * ChoiceResponse/NoulResponse/ScoreResponse (discriminated by `type`) -- validated at read time
 * rather than imported, since web has no dependency on core/the SDK and only reads three fields.
 * An answer that doesn't match a known Jev primitive (e.g. a future adapter-contract fallback
 * shape) is skipped rather than guessed at -- returns null, and the caller drops it.
 */
export function formatDecisionAnswer(key: string, answer: unknown): string | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  if (a.type === 'choice' && typeof a.choice === 'string' && typeof a.confidence === 'number') {
    return `${key}: ${a.choice} (${formatConfidence(a.confidence)})`;
  }
  if (a.type === 'noul' && typeof a.noul === 'number') {
    return `${key}: ${formatConfidence(a.noul)}`;
  }
  if (a.type === 'score' && typeof a.score === 'number' && typeof a.confidence === 'number') {
    return `${key}: ${a.score} (${formatConfidence(a.confidence)})`;
  }
  return null;
}

