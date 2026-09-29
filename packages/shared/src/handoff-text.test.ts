import { describe, expect, it } from 'vitest';
import { renderHandoffText } from './handoff-text';
import type { HandoffSummary } from './dto/workflow';

const base: HandoffSummary = {
  generatedAt: '2026-09-28T12:00:00.000Z',
  sinceHours: 8,
  since: '2026-09-28T04:00:00.000Z',
  open: { total: 3, overdue: 1, awaitingApproval: 1, unassigned: 2, bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0 } },
  needsAttention: [],
  resolved: { total: 2, by: { AGENT: 1, USER: 1, SYSTEM: 0 } },
  recentNotes: [],
};

describe('renderHandoffText', () => {
  it('states the counts and says nothing needs attention when the list is empty', () => {
    const text = renderHandoffText(base);
    expect(text).toContain('last 8 hours');
    expect(text).toContain('Open: 3 (critical 1, high 1, medium 1, low 0). 1 overdue, 1 waiting for approval, 2 unassigned.');
    expect(text).toContain('Resolved: 2 (agent 1, people 1, system 0).');
    expect(text).toContain('Needs attention: nothing.');
    expect(text).not.toContain('Notes this shift');
  });

  it('lists each case with reasons, owner and newest note, and the notes of the shift', () => {
    const text = renderHandoffText({
      ...base,
      sinceHours: 1,
      needsAttention: [
        {
          id: 'case_1',
          displayId: 'PAY-0001',
          type: 'PAYMENT_MISMATCH',
          severity: 'HIGH',
          status: 'AWAITING_APPROVAL',
          amountMinor: 1_249_900,
          dueAt: '2026-09-28T16:00:00.000Z',
          overdue: false,
          assigneeName: 'Rahul Menon',
          reasons: ['Waiting for approval'],
          lastNote: { text: 'Bank confirmed.', authorName: 'Ananya Rao', at: '2026-09-28T11:00:00.000Z' },
        },
      ],
      recentNotes: [{ caseId: 'case_1', displayId: 'PAY-0001', text: 'Bank confirmed.', authorName: 'Ananya Rao', at: '2026-09-28T11:00:00.000Z' }],
    });
    expect(text).toContain('last 1 hour ');
    expect(text).toMatch(/- PAY-0001 Payment mismatch, ₹12,499\.00, Waiting for approval, due .+, Rahul Menon/);
    expect(text).toContain('  Note from Ananya Rao: Bank confirmed.');
    expect(text).toContain('- PAY-0001, Ananya Rao: Bank confirmed.');
  });

  it('is deterministic', () => {
    expect(renderHandoffText(base)).toBe(renderHandoffText(base));
  });
});
