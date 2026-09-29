import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiagnosisFeedbackItem } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { FeedbackForm, FeedbackList } from './DiagnosisFeedback';

const base = { diagnosedRootCause: 'ORDER_STATE_DIVERGED' as const, previous: null, pending: false, error: null };

describe('FeedbackForm', () => {
  it('saves a right verdict without asking for a reason', async () => {
    const onSubmit = vi.fn();
    render(<FeedbackForm {...base} onSubmit={onSubmit} />);
    expect(screen.queryByLabelText('Why is it wrong?')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    expect(onSubmit).toHaveBeenCalledWith({ verdict: 'RIGHT', reason: '' });
  });

  it('requires a reason for a wrong verdict and shows why it did not save', async () => {
    const onSubmit = vi.fn();
    render(<FeedbackForm {...base} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Wrong' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Say briefly why the diagnosis is wrong.')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Why is it wrong?'), 'The consumer returned 500.');
    await userEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    expect(onSubmit).toHaveBeenCalledWith({ verdict: 'WRONG', reason: 'The consumer returned 500.' });
  });

  it('starts from the operator\'s earlier answer and offers to update it', () => {
    const previous = { verdict: 'WRONG', reason: 'Only one capture.', correctRootCause: null } as DiagnosisFeedbackItem;
    render(<FeedbackForm {...base} previous={previous} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Why is it wrong?')).toHaveValue('Only one capture.');
    expect(screen.getByRole('button', { name: 'Update feedback' })).toBeVisible();
  });

  it('shows a save error', () => {
    render(<FeedbackForm {...base} error="Request failed." onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed.');
  });
});

describe('FeedbackList', () => {
  it('says so when nobody has judged the diagnosis', () => {
    render(<FeedbackList items={[]} />);
    expect(screen.getByText('No one has judged this diagnosis yet.')).toBeVisible();
  });

  it('lists who said what, with the reason', () => {
    const items = [{ id: 'dfb_1', givenByName: 'Ananya Rao', verdict: 'WRONG', reason: 'The webhook returned 500.', correctRootCause: 'WEBHOOK_PROCESSING_FAILURE' }] as DiagnosisFeedbackItem[];
    render(<FeedbackList items={items} />);
    expect(screen.getByText('Ananya Rao')).toBeVisible();
    expect(screen.getByText('The webhook returned 500.')).toBeVisible();
    expect(screen.getByText('WEBHOOK PROCESSING FAILURE')).toBeVisible();
  });
});
