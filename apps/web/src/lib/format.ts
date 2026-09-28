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
