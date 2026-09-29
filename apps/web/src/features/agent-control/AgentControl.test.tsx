import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { AgentControlItem } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { AgentControlForm, AgentControlNotice, limitSentence } from './AgentControl';

const normal: AgentControlItem = { mode: 'NORMAL', reason: '', changedByName: null, changedAt: null };
const paused: AgentControlItem = { mode: 'PAUSED', reason: 'Gateway outage.', changedByName: 'Meera Iyer', changedAt: '2026-09-29T10:00:00Z' };

describe('limitSentence', () => {
  it('says nothing while the agent runs normally', () => expect(limitSentence(normal)).toBeNull());
  it('names the pause and its reason', () => expect(limitSentence(paused)).toBe('The agent is paused: Gateway outage.'));
  it('names propose only', () => expect(limitSentence({ ...paused, mode: 'PROPOSE_ONLY' })).toBe('The agent is set to propose only: Gateway outage.'));
});

describe('AgentControlNotice', () => {
  it('renders nothing in normal mode', () => {
    const { container } = render(<MemoryRouter><AgentControlNotice control={normal} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the reason, who set it and that people can still work', () => {
    render(<MemoryRouter><AgentControlNotice control={paused} /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent('The agent is paused: Gateway outage.');
    expect(screen.getByRole('status')).toHaveTextContent('Set by Meera Iyer');
    expect(screen.getByRole('link', { name: 'Agent controls' })).toHaveAttribute('href', '/policy');
  });
});

describe('AgentControlForm', () => {
  it('will not limit the agent without a reason', async () => {
    const onSubmit = vi.fn();
    render(<AgentControlForm current={normal} pending={false} error={null} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Paused' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save mode' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Say briefly why the agent is being limited.')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Why?'), 'Gateway outage.');
    await userEvent.click(screen.getByRole('button', { name: 'Save mode' }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'PAUSED', reason: 'Gateway outage.' });
  });

  it('resumes without asking for a reason, and is disabled until something changes', async () => {
    const onSubmit = vi.fn();
    render(<AgentControlForm current={paused} pending={false} error={null} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Save mode' })).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Normal' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save mode' }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'NORMAL', reason: '' });
  });
});
