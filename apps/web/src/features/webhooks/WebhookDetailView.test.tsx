import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { WebhookLogDetail } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { WebhookDetailView } from './WebhooksPage';

const now = new Date('2026-09-29T10:00:00.000Z');
const detail: WebhookLogDetail = {
  id: 'evt_1',
  event: 'payment.captured',
  gwPaymentId: 'gwpay_1',
  gwRefundId: null,
  status: 'FAILED',
  attemptCount: 2,
  lastHttpStatus: 500,
  lastMessage: 'Internal Server Error',
  nextRetryAt: '2026-09-29T10:30:00.000Z',
  firstReceivedAt: '2026-09-29T09:00:00.000Z',
  updatedAt: '2026-09-29T09:31:00.000Z',
  payload: { id: 'evt_1', event: 'payment.captured', gwPaymentId: 'gwpay_1', gwRefundId: null, createdAt: '2026-09-29T09:00:00.000Z' },
  attempts: [
    { at: '2026-09-29T09:00:00.000Z', source: 'GATEWAY', httpStatus: 500, outcome: 'ERROR', message: 'Internal Server Error' },
    { at: '2026-09-29T09:31:00.000Z', source: 'RETRY', httpStatus: 500, outcome: 'ERROR', message: 'Internal Server Error' },
  ],
};

const view = (over: Partial<Parameters<typeof WebhookDetailView>[0]> = {}) =>
  render(
    <MemoryRouter>
      <WebhookDetailView d={detail} now={now} canReplay pending={false} error={null} onReplay={vi.fn()} {...over} />
    </MemoryRouter>,
  );

describe('WebhookDetailView', () => {
  it('lists each attempt with who caused it, and when the next retry runs', () => {
    view();
    expect(screen.getByText('1. Gateway')).toBeVisible();
    expect(screen.getByText('2. Automatic retry')).toBeVisible();
    expect(screen.getByText('Retry in 30m')).toBeVisible();
    expect(screen.getByText(/"gwPaymentId": "gwpay_1"/)).toBeVisible();
  });

  it('asks for confirmation before replaying', async () => {
    const onReplay = vi.fn();
    view({ onReplay });
    await userEvent.click(screen.getByRole('button', { name: 'Replay this event' }));
    expect(onReplay).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm replay' }));
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('offers no replay to a viewer', () => {
    view({ canReplay: false });
    expect(screen.queryByRole('button', { name: 'Replay this event' })).toBeNull();
    expect(screen.getByText('Replaying needs an Ops or manager account.')).toBeVisible();
  });

  it('shows a server error', () => {
    view({ error: 'Webhook event evt_1 not found' });
    expect(screen.getByRole('alert')).toHaveTextContent('not found');
  });
});
