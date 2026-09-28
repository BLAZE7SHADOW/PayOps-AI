import { describe, expect, it } from 'vitest';
import type { ActionOption } from '@payops/shared';
import { buildActions, initialDrafts, parseAmount, validateDraft } from './resolve-form';

const refund: ActionOption = {
  type: 'INITIATE_REFUND',
  action: { type: 'INITIATE_REFUND', params: { gwPaymentId: 'gwp_abc123', amountMinor: 78_000_00, reason: 'Order cancelled' } },
  summary: 'Refund up to ₹78,000.00',
  recommended: true,
  available: true,
  unavailableReason: null,
  editable: ['amountMinor', 'reason'],
  maxAmountMinor: 78_000_00,
};

describe('refund amount validation', () => {
  it('parses rupees to paise with shared toMinor', () => {
    expect(parseAmount('12,499.50', null)).toEqual({ minor: 12_499_50 });
  });

  it('rejects amounts above maxAmountMinor, zero and junk', () => {
    expect(parseAmount('78,000.01', 78_000_00)).toEqual({ error: 'Up to ₹78,000.00, the refundable balance.' });
    expect(parseAmount('78000', 78_000_00)).toEqual({ minor: 78_000_00 });
    expect(parseAmount('0', 78_000_00)).toEqual({ error: 'Amount must be more than ₹0.00.' });
    expect(parseAmount('12.345', null)).toEqual({ error: 'Enter an amount like 12,499.00.' });
    expect(parseAmount('', null)).toEqual({ error: 'Enter an amount.' });
  });

  it('prefills from the option and blocks the proposal while the amount is invalid', () => {
    const drafts = initialDrafts([refund]);
    expect(drafts[0]).toMatchObject({ checked: true, amount: '78,000.00', reason: 'Order cancelled' });
    const actions = buildActions([refund], drafts);
    expect(actions?.[0]).toMatchObject({ type: 'INITIATE_REFUND', params: { amountMinor: 78_000_00 } });

    const tooMuch = [{ ...drafts[0]!, amount: '90,000' }];
    expect(validateDraft(refund, tooMuch[0]!).amount).toMatch(/Up to ₹78,000.00/);
    expect(buildActions([refund], tooMuch)).toBeNull();

    const partial = [{ ...drafts[0]!, amount: '1,500' }];
    expect(buildActions([refund], partial)?.[0]).toMatchObject({ params: { amountMinor: 1_500_00 } });
  });
});
