import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SYSTEMS, type MatrixCell, type StateMatrix as Matrix, type SystemKey } from '@payops/shared';
import { StateMatrix } from './StateMatrix';

function matrix(overrides: Partial<Record<SystemKey, Partial<MatrixCell>>>): Matrix {
  const cells = Object.fromEntries(
    SYSTEMS.map((s) => [
      s,
      { system: s, status: 'OK', amountMinor: 12_499_00, at: null, detail: null, mismatch: false, reference: s === 'GATEWAY', ...overrides[s] },
    ]),
  ) as Record<SystemKey, MatrixCell>;
  return { cells, mismatched: SYSTEMS.filter((s) => cells[s].mismatch) };
}

const capturedOrderFailed = matrix({
  GATEWAY: { status: 'CAPTURED' },
  ORDER: { status: 'FAILED', mismatch: true },
  LEDGER: { status: 'MISSING', amountMinor: null, mismatch: true },
  WEBHOOK: { status: 'HTTP 500 ×3', amountMinor: null, mismatch: true },
  SETTLEMENT: { status: 'SETTLED' },
});

describe('StateMatrix', () => {
  it('marks the gateway column as REFERENCE', () => {
    render(<StateMatrix matrix={capturedOrderFailed} />);
    const header = screen.getByRole('columnheader', { name: /Gateway/ });
    expect(within(header).getByText('REFERENCE')).toBeInTheDocument();
    expect(screen.getAllByText('REFERENCE')).toHaveLength(1);
  });

  it('marks every mismatched cell with a ▲, a tint and an aria-label', () => {
    const { container } = render(<StateMatrix matrix={capturedOrderFailed} />);
    for (const [system, status] of [
      ['Order', 'FAILED'],
      ['Ledger', 'MISSING'],
      ['Webhook', 'HTTP 500 ×3'],
    ] as const) {
      const cell = screen.getByLabelText(`${system} status ${status}: disagrees with the reference`);
      expect(cell).toHaveClass('bg-bad-weak');
      expect(within(cell).getByText('▲')).toBeInTheDocument();
    }
    // 3 systems × 4 rows are tinted; only status cells carry the marker.
    expect(container.querySelectorAll('td[data-mismatch]')).toHaveLength(12);
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(3);
  });

  it('leaves agreeing systems unmarked', () => {
    render(<StateMatrix matrix={capturedOrderFailed} />);
    const settled = screen.getByText('SETTLED').closest('td');
    expect(settled).not.toHaveAttribute('data-mismatch');
    expect(settled).not.toHaveAttribute('aria-label');
    expect(within(settled as HTMLElement).queryByText('▲')).toBeNull();
  });

  it('shows missing values as a dash and amounts as money', () => {
    render(<StateMatrix matrix={capturedOrderFailed} />);
    expect(screen.getAllByText('₹12,499.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });
});
