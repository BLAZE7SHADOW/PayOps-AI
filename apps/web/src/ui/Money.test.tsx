import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from './Money';

describe('Money', () => {
  it('renders rupees with Indian grouping and two decimals', () => {
    render(<Money minor={12_499_00} />);
    expect(screen.getByText('₹12,499.00')).toBeInTheDocument();
  });

  it('groups lakhs the Indian way', () => {
    render(<Money minor={1_18_425_00} />);
    expect(screen.getByText('₹1,18,425.00')).toBeInTheDocument();
  });

  it('uses mono tabular numerals', () => {
    render(<Money minor={236_85} />);
    const el = screen.getByText('₹236.85');
    expect(el).toHaveClass('font-mono', 'tabular');
  });

  it('compact form keeps the exact amount in the title', () => {
    render(<Money minor={42_18_650_00} compact />);
    const el = screen.getByText('₹42.2 L');
    expect(el).toHaveAttribute('title', '₹42,18,650.00');
  });
});
