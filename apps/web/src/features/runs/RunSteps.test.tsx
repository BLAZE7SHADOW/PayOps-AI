import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunSteps } from './RunSteps';
import { fullRun, run } from './run-detail.fixtures';

function renderRun() {
  render(<RunSteps run={run()} steps={fullRun} />);
}

describe('RunSteps', () => {
  it('explains how the run was routed and that the step order is fixed', () => {
    renderRun();
    const routing = screen.getByRole('region', { name: 'How this run was routed' });
    expect(within(routing).getByText(/Full investigation/)).toBeInTheDocument();
    expect(within(routing).getByText(/order of steps is fixed and bounded/)).toBeInTheDocument();
  });

  it('labels each step as fixed or chosen for this case', () => {
    renderRun();
    expect(screen.getAllByText('Fixed step').length).toBeGreaterThan(3);
    expect(screen.getAllByText('Chosen for this case').length).toBeGreaterThan(1);
  });

  it('shows what was called, including the Jev answers, and why the fast path was not taken', () => {
    renderRun();
    expect(screen.getByText('Asked Jev (J6 diagnosis)')).toBeInTheDocument();
    expect(screen.getByText('root_cause: webhook_or_state_sync (71%)')).toBeInTheDocument();
    expect(screen.getAllByText(/confidence 71% is below 80%/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/The fast path was not taken/)).toBeInTheDocument();
  });

  it('shows the extra records a specialist asked for and the reason', () => {
    renderRun();
    expect(screen.getByText('Read order timeline: See why the order is FAILED.')).toBeInTheDocument();
    expect(screen.getByText(/Suggested payment attempts but it was not run/)).toBeInTheDocument();
  });

  it('links each cited evidence id to its record in the evidence list', () => {
    renderRun();
    const link = screen.getAllByRole('link', { name: '[ev_03]' })[0]!;
    expect(link).toHaveAttribute('href', '#run-ev-ev_03');
    expect(document.getElementById('run-ev-ev_03')).not.toBeNull();
  });

  it('states what happens next after each step', () => {
    renderRun();
    expect(screen.getByText(/Next: Execute. The AUTO tier needs no approval./)).toBeInTheDocument();
    expect(screen.getByText(/Next: Close the case as resolved/)).toBeInTheDocument();
  });
});
