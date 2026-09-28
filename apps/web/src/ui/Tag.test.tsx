import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tag } from './Tag';

describe('Tag', () => {
  it('renders the status text and exposes its tone', () => {
    const { container } = render(<Tag tone="bad">FAILED</Tag>);
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    const tag = container.firstElementChild;
    expect(tag).toHaveAttribute('data-tone', 'bad');
    expect(tag).toHaveClass('text-bad');
  });

  it('draws a decorative swatch hidden from assistive tech', () => {
    const { container } = render(<Tag tone="ok">CAPTURED</Tag>);
    const swatch = container.querySelector('[aria-hidden="true"]');
    expect(swatch).toHaveClass('bg-ok');
  });

  it('defaults to the neutral tone', () => {
    const { container } = render(<Tag>OPEN</Tag>);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'neutral');
  });
});
