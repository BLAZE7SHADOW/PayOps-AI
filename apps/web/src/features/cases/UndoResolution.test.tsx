import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UndoResolutionView } from './UndoResolution';

const base = { amountMinor: 499900, pending: false, error: null };

describe('UndoResolutionView', () => {
  it('asks for confirmation before sending anything', async () => {
    const onUndo = vi.fn();
    render(<UndoResolutionView {...base} onUndo={onUndo} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo ledger post' }));
    expect(onUndo).not.toHaveBeenCalled();
    expect(screen.getByText(/reopens the case and proposes reversing the ₹4,999.00 ledger entry/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Propose undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
  it('can be cancelled', async () => {
    render(<UndoResolutionView {...base} onUndo={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo ledger post' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Undo ledger post' })).toBeVisible();
  });
  it('shows a server error', () => {
    render(<UndoResolutionView {...base} error="Only the latest resolution on a case can be undone" onUndo={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('latest resolution');
  });
});
