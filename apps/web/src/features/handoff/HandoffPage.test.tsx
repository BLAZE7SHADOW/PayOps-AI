import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HandoffSummary } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { HandoffView } from './HandoffPage';

const now = new Date('2026-09-28T12:00:00.000Z');
const base: HandoffSummary = {
  generatedAt: now.toISOString(),
  sinceHours: 8,
  since: '2026-09-28T04:00:00.000Z',
  open: { total: 3, overdue: 1, awaitingApproval: 1, unassigned: 2, bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0 } },
  needsAttention: [],
  resolved: { total: 2, by: { AGENT: 1, USER: 1, SYSTEM: 0 } },
  recentNotes: [],
};

const view = (h: HandoffSummary) =>
  render(
    <MemoryRouter>
      <HandoffView h={h} now={now} />
    </MemoryRouter>,
  );

describe('HandoffView', () => {
  it('shows the counts and says when nothing needs attention or was noted', () => {
    view(base);
    expect(screen.getByText('Overdue').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Nothing is overdue, critical or waiting for approval.')).toBeVisible();
    expect(screen.getByText('No one wrote a note in this window.')).toBeVisible();
  });

  it('lists a case with its reasons, owner and newest note, linking to the case', () => {
    view({
      ...base,
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
          assigneeName: null,
          reasons: ['Waiting for approval'],
          lastNote: { text: 'Bank confirmed.', authorName: 'Ananya Rao', at: '2026-09-28T11:00:00.000Z' },
        },
      ],
    });
    expect(screen.getByRole('link', { name: 'PAY-0001' })).toHaveAttribute('href', '/cases/case_1');
    // Once as a count label, once as the reason tag on the case.
    expect(screen.getAllByText('Waiting for approval')).toHaveLength(2);
    expect(screen.getAllByText('Unassigned')).toHaveLength(2);
    expect(screen.getByText('Ananya Rao: Bank confirmed.')).toBeVisible();
    expect(screen.getByText('in 4h')).toBeVisible();
  });
});
