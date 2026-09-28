import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DecisionForm } from './DecisionForm';

const open = { canDecide: true, cannotDecideReason: null, tier: 'OPS' as const };

describe('DecisionForm', () => {
  it('approves without a comment', async () => {
    const onDecide = vi.fn();
    render(<DecisionForm approval={open} role="OPS" pending={null} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('APPROVE', '');
  });

  it('requires a comment of at least 5 characters to reject or escalate', async () => {
    const onDecide = vi.fn();
    render(<DecisionForm approval={open} role="OPS" pending={null} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText('Add a comment of at least 5 characters to reject.')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment')).toHaveAttribute('aria-invalid', 'true');

    await userEvent.type(screen.getByLabelText('Comment'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Escalate' }));
    expect(screen.getByText('Add a comment of at least 5 characters to escalate.')).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Comment'), ' way');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith('REJECT', 'nope way');
  });

  it('shows cannotDecideReason and disables every control when the viewer may not decide', () => {
    render(
      <DecisionForm
        approval={{ canDecide: false, cannotDecideReason: 'You requested this. Another person must approve it.', tier: 'MANAGER' }}
        role="OPS"
        pending={null}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('You requested this. Another person must approve it.')).toBeInTheDocument();
    for (const name of ['Approve', 'Reject', 'Escalate']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByLabelText('Comment')).toBeDisabled();
  });

  it('shows a view-only note instead of controls for viewers', () => {
    render(<DecisionForm approval={open} role="VIEWER" pending={null} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText(/You have view access/)).toBeInTheDocument();
  });
});
