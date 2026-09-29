/**
 * Plain-text version of a shift handoff (P2 task 2, D068), for pasting into chat or email.
 * Pure and deterministic: the same summary always gives the same text.
 */
import { CASE_TYPE_LABEL } from './enums';
import { formatMoney } from './money';
import { dueLabel } from './time';
import type { HandoffSummary } from './dto/workflow';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderHandoffText(h: HandoffSummary): string {
  const now = new Date(h.generatedAt);
  const lines: string[] = [];
  lines.push(`Shift handoff, last ${plural(h.sinceHours, 'hour')} (generated ${h.generatedAt})`);
  lines.push('');
  const s = h.open.bySeverity;
  lines.push(
    `Open: ${h.open.total} (critical ${s.CRITICAL}, high ${s.HIGH}, medium ${s.MEDIUM}, low ${s.LOW}). ` +
      `${h.open.overdue} overdue, ${h.open.awaitingApproval} waiting for approval, ${h.open.unassigned} unassigned.`,
  );
  lines.push(
    `Resolved: ${h.resolved.total} (agent ${h.resolved.by.AGENT}, people ${h.resolved.by.USER}, system ${h.resolved.by.SYSTEM}).`,
  );

  lines.push('');
  if (h.needsAttention.length === 0) {
    lines.push('Needs attention: nothing.');
  } else {
    lines.push('Needs attention:');
    for (const c of h.needsAttention) {
      const due = c.dueAt ? `, due ${dueLabel(c.dueAt, now)}` : '';
      const who = c.assigneeName ?? 'unassigned';
      lines.push(`- ${c.displayId} ${CASE_TYPE_LABEL[c.type]}, ${formatMoney(c.amountMinor)}, ${c.reasons.join(', ')}${due}, ${who}`);
      if (c.lastNote) lines.push(`  Note from ${c.lastNote.authorName}: ${c.lastNote.text}`);
    }
  }

  if (h.recentNotes.length > 0) {
    lines.push('');
    lines.push('Notes this shift:');
    for (const n of h.recentNotes) lines.push(`- ${n.displayId}, ${n.authorName}: ${n.text}`);
  }
  return lines.join('\n');
}
