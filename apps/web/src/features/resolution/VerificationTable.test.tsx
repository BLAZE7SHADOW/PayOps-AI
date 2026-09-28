import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ValidationCheck, ValidationResultDto } from '@payops/shared';
import { verdictLine } from '../../lib/resolution';
import { VerificationTable } from './VerificationTable';

const chk = (id: string, kind: ValidationCheck['kind'], pass: boolean): ValidationCheck => ({
  id,
  subject: `subject.${id}`,
  description: `desc ${id}`,
  expected: 'PAID',
  actual: pass ? 'PAID' : 'FAILED',
  pass,
  kind,
  actionIndex: kind === 'POSTCONDITION' ? 0 : null,
});

const failed: ValidationResultDto = {
  id: 'val_1',
  verdict: 'FAIL',
  at: '2026-09-28T10:00:00.000Z',
  checks: [chk('inv1', 'INVARIANT', true), chk('post1', 'POSTCONDITION', false), chk('post2', 'POSTCONDITION', true), chk('inv2', 'INVARIANT', true), chk('inv3', 'INVARIANT', true)],
};

describe('VerificationTable', () => {
  it('groups postconditions before invariants', () => {
    render(<VerificationTable validation={failed} actions={[{ type: 'MARK_ORDER_PAID', params: { orderId: 'ord_1abc', paymentId: 'pay_1abc' } }]} />);
    const bodies = screen.getByRole('table', { name: 'Verification checks' }).querySelectorAll('tbody');
    expect(bodies).toHaveLength(2);
    expect(within(bodies[0] as HTMLElement).getByRole('columnheader', { name: 'Action postconditions' })).toBeInTheDocument();
    expect(within(bodies[0] as HTMLElement).getAllByText(/^subject\.post/)).toHaveLength(2);
    expect(within(bodies[1] as HTMLElement).getByRole('columnheader', { name: 'Case invariants' })).toBeInTheDocument();
    expect(within(bodies[1] as HTMLElement).getAllByText(/^subject\.inv/)).toHaveLength(3);
  });

  it('marks FAIL rows with a tag and the bad tint, never color alone', () => {
    const { container } = render(<VerificationTable validation={failed} />);
    const failRows = container.querySelectorAll('tr[data-result="FAIL"]');
    expect(failRows).toHaveLength(1);
    const row = failRows[0] as HTMLElement;
    expect(within(row).getByText('FAIL')).toBeInTheDocument();
    expect(within(row).getByText('subject.post1').closest('td')).toHaveClass('bg-bad-weak');
    expect(container.querySelectorAll('tr[data-result="PASS"] .bg-bad-weak')).toHaveLength(0);
    expect(container.querySelectorAll('tr[data-result="PASS"]')).toHaveLength(4);
  });

  it('states the verdict with counts', () => {
    expect(verdictLine('FAIL', failed.checks)).toBe('Verified: FAIL · 1 of 5 checks failed');
    expect(verdictLine('PASS', failed.checks.map((x) => ({ ...x, pass: true })))).toBe('Verified: PASS · 5 of 5 checks');
    render(<VerificationTable validation={failed} />);
    expect(screen.getByText('· 1 of 5 checks failed')).toBeInTheDocument();
  });
});
