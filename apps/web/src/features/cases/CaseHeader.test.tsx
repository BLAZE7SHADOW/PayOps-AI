import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssignmentView } from './CaseHeader';

const base = { meId: 'usr_me', canAssign: true, pending: false, failed: false };
const other = { id: 'usr_other', name: 'Rahul Menon' };

describe('AssignmentView', () => {
  it('offers to take an unassigned case', async () => {
    const onAssign = vi.fn();
    render(<AssignmentView {...base} assignee={null} onAssign={onAssign} />);
    expect(screen.getByText('Unassigned')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Assign to me' }));
    expect(onAssign).toHaveBeenCalledWith('usr_me');
  });

  it('offers to take over a case held by someone else', async () => {
    const onAssign = vi.fn();
    render(<AssignmentView {...base} assignee={other} onAssign={onAssign} />);
    expect(screen.getByText('Assigned to Rahul Menon')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(onAssign).toHaveBeenCalledWith('usr_me');
  });

  it('lets me hand my own case back', async () => {
    const onAssign = vi.fn();
    render(<AssignmentView {...base} assignee={{ id: 'usr_me', name: 'Ananya Rao' }} onAssign={onAssign} />);
    expect(screen.getByText('Assigned to you')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    expect(onAssign).toHaveBeenCalledWith(null);
  });

  it('shows no buttons to viewers or on closed cases, only the owner', () => {
    render(<AssignmentView {...base} canAssign={false} assignee={other} onAssign={vi.fn()} />);
    expect(screen.getByText('Assigned to Rahul Menon')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables the button while saving and shows a failure', () => {
    render(<AssignmentView {...base} pending failed assignee={null} onAssign={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Assign to me' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not change the assignee.');
  });
});
