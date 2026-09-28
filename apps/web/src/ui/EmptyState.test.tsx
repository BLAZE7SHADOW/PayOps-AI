import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('shows one line of text plus the next action', () => {
    render(<EmptyState message="No open exceptions." action={<a href="/simulator">Generate a scenario from the Simulator.</a>} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('No open exceptions. Generate a scenario from the Simulator.');
    expect(screen.getByRole('link', { name: 'Generate a scenario from the Simulator.' })).toHaveAttribute('href', '/simulator');
  });

  it('works without an action', () => {
    render(<EmptyState message="No lifecycle events recorded." />);
    expect(screen.getByRole('status')).toHaveTextContent('No lifecycle events recorded.');
  });
});
