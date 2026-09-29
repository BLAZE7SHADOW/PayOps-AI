import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedViewItem } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { SavedViews } from './SavedViews';

const view = (o: Partial<SavedViewItem> = {}): SavedViewItem => ({ id: 'viw_1', name: 'My overdue', filters: { overdue: true }, createdAt: '2026-09-28T12:00:00.000Z', ...o });
const base = { views: [], activeId: undefined, canSave: false, pending: false, error: null, onApply: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() };

describe('SavedViews', () => {
  it('offers nothing when there are no views and nothing to save', () => {
    render(<SavedViews {...base} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved view')).not.toBeInTheDocument();
  });

  it('offers to save the current filters, asks for a name, and saves the trimmed name', async () => {
    const onSave = vi.fn();
    render(<SavedViews {...base} canSave onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as view' }));
    expect(screen.getByRole('button', { name: 'Save view' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('View name'), '  Critical today ');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(onSave).toHaveBeenCalledWith('Critical today');
    expect(screen.getByRole('button', { name: 'Save as view' })).toBeVisible();
  });

  it('cancelling drops the name', async () => {
    const onSave = vi.fn();
    render(<SavedViews {...base} canSave onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as view' }));
    await userEvent.type(screen.getByLabelText('View name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save as view' })).toBeVisible();
  });

  it('shows the active view with a delete button instead of save', async () => {
    const onDelete = vi.fn();
    render(<SavedViews {...base} views={[view()]} activeId="viw_1" canSave onDelete={onDelete} />);
    expect(screen.queryByRole('button', { name: 'Save as view' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(onDelete).toHaveBeenCalledWith('viw_1');
  });

  it('shows a save error', () => {
    render(<SavedViews {...base} error='You already have a view named "x".' />);
    expect(screen.getByRole('alert')).toHaveTextContent('You already have a view named');
  });
});
