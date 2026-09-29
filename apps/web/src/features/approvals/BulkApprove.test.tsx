import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ApprovalItem } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { BulkApprove } from './BulkApprove';

const item = (id: string, displayId: string): ApprovalItem =>
  ({
    id,
    case: { id: `cas_${id}`, displayId, type: 'DUPLICATE', status: 'AWAITING_APPROVAL', amountMinor: 200_000 },
    tier: 'OPS',
    status: 'PENDING',
    actionsSummary: 'Refund duplicate',
    moneyMovingMinor: 200_000,
  }) as ApprovalItem;

const base = { pending: false, error: null, result: null, onApprove: vi.fn() };
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('BulkApprove', () => {
  it('renders nothing when there is nothing to approve and no result', () => {
    const { container } = wrap(<BulkApprove {...base} items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('approves every item by default and only the ones still checked', async () => {
    const onApprove = vi.fn();
    wrap(<BulkApprove {...base} onApprove={onApprove} items={[item('a', 'PAY-0001'), item('b', 'PAY-0002')]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve 2 selected' }));
    expect(onApprove).toHaveBeenLastCalledWith(['a', 'b']);
    await userEvent.click(screen.getByLabelText('Include PAY-0002'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve 1 selected' }));
    expect(onApprove).toHaveBeenLastCalledWith(['a']);
  });

  it('disables the button when nothing is checked or while approving', async () => {
    const { rerender } = wrap(<BulkApprove {...base} items={[item('a', 'PAY-0001')]} />);
    await userEvent.click(screen.getByLabelText('Include PAY-0001'));
    expect(screen.getByRole('button', { name: 'Approve 0 selected' })).toBeDisabled();
    rerender(
      <MemoryRouter>
        <BulkApprove {...base} pending items={[item('a', 'PAY-0001')]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Approving' })).toBeDisabled();
  });

  it('summarizes the result and says why items were skipped', () => {
    wrap(
      <BulkApprove
        {...base}
        items={[]}
        result={{
          approved: 1,
          skipped: 1,
          failed: 0,
          items: [
            { approvalId: 'a', displayId: 'PAY-0001', outcome: 'APPROVED', message: 'Approved.' },
            { approvalId: 'b', displayId: 'PAY-0002', outcome: 'SKIPPED', message: 'The case has quarantined notes. Open the case.' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 approved, 1 skipped, 0 failed.');
    expect(screen.getByRole('status')).toHaveTextContent('PAY-0002: The case has quarantined notes');
  });
});
