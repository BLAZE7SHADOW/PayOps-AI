import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HandoffCard } from './HandoffCard';

describe('HandoffCard', () => {
  it('shows the title, the recorded reason and the next steps', () => {
    render(<HandoffCard handoff={{ title: 'The agent could not confirm the cause.', reason: 'No known cause fits.', steps: ['Check the source records.', 'Resolve manually.'] }} />);
    expect(screen.getByRole('heading', { name: 'The agent could not confirm the cause.' })).toBeVisible();
    expect(screen.getByText('No known cause fits.')).toBeVisible();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Check the source records.', 'Resolve manually.']);
  });
});
