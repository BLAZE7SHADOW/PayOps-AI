/**
 * D060: the rendered case story. Pure-render pieces only (StoryList), the same shape as the other
 * feature tests, so no query hooks or router are needed.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { CaseDetail } from '@payops/shared';
import { buildCaseStory } from './case-story';
import { caseDetail, records, resolution, run, steps } from './case-story.fixtures';
import { StoryList } from './CaseStory';

function renderStory(c: CaseDetail, onOpen = vi.fn(), pendingApprovalId: string | null = null, runOverride = run()) {
  const story = buildCaseStory({ c, run: runOverride, steps, records });
  render(<MemoryRouter><StoryList story={story} onOpen={onOpen} pendingApprovalId={pendingApprovalId} /></MemoryRouter>);
  return onOpen;
}

const resolved = { ...caseDetail, resolutionView: { resolutions: [resolution()] } } as unknown as CaseDetail;

describe('StoryList', () => {
  it('shows who produced each step and separates data from agent findings', () => {
    renderStory(resolved);
    expect(screen.getAllByText('GEMINI').length).toBeGreaterThan(0);
    expect(screen.getByText('Jev · J2 plan')).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed by data').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent finding')).toHaveLength(2);
    expect(screen.getByText('Not supported by its evidence')).toBeInTheDocument();
    expect(screen.getByText('Evidence does not mention this.')).toBeInTheDocument();
  });

  it('opens the cited record when an evidence reference is clicked', async () => {
    const onOpen = renderStory(resolved);
    await userEvent.click(screen.getAllByRole('button', { name: '[ev_02]' })[0]!);
    expect(onOpen).toHaveBeenCalledWith('ev_02');
  });

  it('shows the recorded before-state beside the current value and links the record', async () => {
    const onOpen = renderStory(resolved);
    const row = screen.getByRole('button', { name: 'Order ord_1' }).closest('tr')!;
    expect(within(row).getByText('FAILED')).toBeInTheDocument();
    expect(within(row).getByText('PAID')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Order ord_1' }));
    expect(onOpen).toHaveBeenCalledWith('rec:ord_1');
  });

  it('shows expected against actual with a pass result', () => {
    renderStory(resolved);
    const table = screen.getByRole('region', { name: 'Verification checks' });
    expect(within(table).getByText('Order is paid')).toBeInTheDocument();
    expect(within(table).getByText('Pass')).toBeInTheDocument();
  });

  it('says an automatic action needed no approval', () => {
    renderStory(resolved);
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText(/No approval was needed/)).toBeInTheDocument();
  });

  it('explains who a waiting case is blocked on and links the approval', () => {
    const waiting = { ...caseDetail, status: 'AWAITING_APPROVAL', resolutionView: { resolutions: [resolution({
      status: 'AWAITING_APPROVAL', executions: [], validation: null,
      policy: { tier: 'OPS', reasons: [{ ruleId: 'P2', tier: 'OPS', reason: 'Above the automatic limit.' }], version: '1', moneyMovingMinor: 0, riskTier: 'LOW' },
      approval: { id: 'apr_1', tier: 'OPS', status: 'PENDING', decidedBy: null, comment: null, decidedAt: null },
    })] } } as unknown as CaseDetail;
    renderStory(waiting, vi.fn(), 'apr_1', run({ status: 'AWAITING_APPROVAL' }));
    expect(screen.getByText('Waiting for OPS')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been changed yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the approval request' })).toHaveAttribute('href', '/approvals?approval=apr_1');
    expect(screen.queryByText('Applied the action')).not.toBeInTheDocument();
  });
});
