import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentStepItem } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { RunFlow } from './RunFlow';

const steps: AgentStepItem[] = [
  { id: '1', runId: 'run_1', seq: 1, node: 'plan', kind: 'NODE_STARTED', payload: {}, at: '2026-09-29T10:00:00Z' },
  { id: '2', runId: 'run_1', seq: 2, node: 'plan', kind: 'NODE_COMPLETED', payload: {}, at: '2026-09-29T10:00:01Z' },
  { id: '3', runId: 'run_1', seq: 3, node: 'paymentAgent', kind: 'NODE_STARTED', payload: {}, at: '2026-09-29T10:00:02Z' },
  { id: '4', runId: 'run_1', seq: 4, node: 'paymentAgent', kind: 'TOOL_COMPLETED', payload: { tools: ['get_payment'], evidenceIds: ['ev_01'] }, at: '2026-09-29T10:00:03Z' },
  { id: '5', runId: 'run_1', seq: 5, node: 'paymentAgent', kind: 'NODE_COMPLETED', payload: {}, at: '2026-09-29T10:00:04Z' },
];

describe('RunFlow', () => {
  it('reveals recorded agent actions and cited evidence when a branch is opened', async () => {
    render(<RunFlow steps={steps} status="RESOLVED" />);
    expect(screen.getByRole('heading', { name: 'Specialist branches' })).toBeInTheDocument();
    expect(screen.getByText('Payment agent')).toBeInTheDocument();
    expect(screen.queryByText('Risk agent')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Payment agent'));
    await userEvent.click(within(screen.getByText('Payment agent').closest('details')!).getByText('Technical events'));
    expect(screen.getByText('get_payment')).toBeVisible();
    expect(screen.getByText('Evidence ev_01')).toBeVisible();
  });

  it('shows a recorded provider retry beside the decision it delayed', () => {
    render(<RunFlow steps={[
      { id: '1', runId: 'run_1', seq: 1, node: 'plan', kind: 'NODE_STARTED', payload: {}, at: '2026-09-29T10:00:00Z' },
      { id: '2', runId: 'run_1', seq: 2, node: 'plan', kind: 'MODEL_RETRY', payload: { provider: 'Jev', reason: 'rate_limited', attempt: 1, maxAttempts: 3, delayMs: 250 }, at: '2026-09-29T10:00:01Z' },
      { id: '3', runId: 'run_1', seq: 3, node: 'plan', kind: 'NODE_COMPLETED', payload: { specialists: ['payment'] }, at: '2026-09-29T10:00:02Z' },
    ]} status="RESOLVED" />);
    expect(screen.getByText('Temporary model issue: retried 1 time.')).toBeVisible();
  });
});
