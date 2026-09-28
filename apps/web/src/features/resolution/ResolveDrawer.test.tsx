import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOption, CaseDetail, CatalogAction, PolicyPreview, PolicyTier } from '@payops/shared';
import { submitLabel } from '../../lib/resolution';
import { jsonResponse, renderApp } from '../../test/render';
import { ResolveForm } from './ResolveDrawer';

const option = (o: Partial<ActionOption> & Pick<ActionOption, 'action'>): ActionOption => ({
  type: o.action.type,
  summary: 'summary',
  recommended: false,
  available: true,
  unavailableReason: null,
  editable: [],
  maxAmountMinor: null,
  ...o,
});

const options: ActionOption[] = [
  option({ action: { type: 'POST_LEDGER_ENTRY', params: { paymentId: 'pay_abc123', amountMinor: 12_499_00 } }, recommended: true }),
  option({
    action: { type: 'INITIATE_REFUND', params: { gwPaymentId: 'gwp_abc123', amountMinor: 12_499_00, reason: 'Order failed' } },
    editable: ['amountMinor', 'reason'],
    maxAmountMinor: 12_499_00,
  }),
  option({ action: { type: 'SYNC_REFUND_STATUS', params: { refundId: 'rfd_abc123' } }, available: false, unavailableReason: 'No refund exists for this payment.' }),
];

const c = {
  id: 'case_1',
  displayId: 'PAY-0042',
  type: 'PAYMENT_MISMATCH',
  amountMinor: 12_499_00,
  resolutionView: { actionOptions: options, resolutions: [], pendingApprovalId: null, canPropose: true, cannotProposeReason: null },
} as unknown as CaseDetail;

function preview(tier: PolicyTier, actions: CatalogAction[]): PolicyPreview {
  const refund = actions.some((a) => a.type === 'INITIATE_REFUND');
  return {
    decision: { tier, reasons: [{ ruleId: refund ? 'P0' : 'P6', tier, reason: 'test' }], version: 'test', moneyMovingMinor: 0, riskTier: 'LOW' },
    preconditionFailures: tier === 'BLOCKED' ? [{ actionIndex: 1, type: 'INITIATE_REFUND', message: 'Order is PAID.' }] : [],
    approverHint: null,
    attempt: 1,
  };
}

/** The fake server decides the tier from the proposal: a refund is BLOCKED, anything else is `base`. */
function stubPreview(base: PolicyTier) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { actions } = JSON.parse(String(init?.body)) as { actions: CatalogAction[] };
    return jsonResponse(preview(actions.some((a) => a.type === 'INITIATE_REFUND') ? 'BLOCKED' : base, actions));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const submit = () => screen.getByRole('button', { name: /Execute now|Request|Blocked|Checking|Select|Fix/ });

describe('submitLabel', () => {
  it('says exactly what submit will do for each tier', () => {
    expect(submitLabel('AUTO')).toBe('Execute now');
    expect(submitLabel('OPS')).toBe('Request OPS approval');
    expect(submitLabel('MANAGER')).toBe('Request manager approval');
    expect(submitLabel('BLOCKED')).toBe('Blocked by policy');
    expect(submitLabel('MANAGER', true)).toBe('Requesting approval…');
  });
});

describe('ResolveForm', () => {
  it('pre-checks recommended options, disables unavailable ones and labels submit from the preview tier', async () => {
    const fetchMock = stubPreview('MANAGER');
    renderApp(<ResolveForm c={c} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText(/Post capture to ledger/)).toBeChecked();
    expect(screen.getByLabelText(/Sync refund status/)).toBeDisabled();
    expect(screen.getByText(/No refund exists for this payment/)).toBeInTheDocument();

    await waitFor(() => expect(submit()).toHaveTextContent('Request manager approval'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/case_1/actions/preview');
    // Rationale still missing, so the button stays disabled.
    expect(submit()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Rationale'), 'Ledger is missing the capture journal.');
    expect(submit()).toBeEnabled();
  });

  it('shows Execute now for AUTO', async () => {
    stubPreview('AUTO');
    renderApp(<ResolveForm c={c} onDone={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(submit()).toHaveTextContent('Execute now'));
  });

  it('blocks submit when the preview is BLOCKED and shows the precondition failure', async () => {
    stubPreview('AUTO');
    renderApp(<ResolveForm c={c} onDone={() => {}} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText('Rationale'), 'Refunding the customer in full.');
    await userEvent.click(screen.getByLabelText(/Refund customer/));
    await waitFor(() => expect(submit()).toHaveTextContent('Blocked by policy'));
    expect(submit()).toBeDisabled();
    expect(screen.getByText(/Order is PAID/)).toBeInTheDocument();
    expect(screen.getByText(/Policy blocks this proposal/)).toBeInTheDocument();
  });

  it('validates the refund amount against maxAmountMinor on blur', async () => {
    stubPreview('OPS');
    renderApp(<ResolveForm c={c} onDone={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByLabelText(/Refund customer/));
    const amount = screen.getByLabelText('Refund amount');
    await userEvent.clear(amount);
    await userEvent.type(amount, '20,000');
    await userEvent.tab();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Up to ₹12,499.00, the refundable balance.')).toBeInTheDocument();
    expect(submit()).toHaveTextContent('Fix the highlighted fields');
    expect(submit()).toBeDisabled();
  });
});
