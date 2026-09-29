import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceRef, evidenceAnchor } from './EvidenceRef';

describe('EvidenceRef', () => {
  it('opens collapsed evidence and focuses the cited row', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const highlight = vi.fn();
    render(<>
      <EvidenceRef runId="run_1" id="ev_1" onHighlight={highlight} />
      <details><summary>Evidence</summary><div id={evidenceAnchor('run_1', 'ev_1')} tabIndex={-1}>Fact</div></details>
    </>);

    await userEvent.click(screen.getByRole('link', { name: '[ev_1]' }));
    expect(screen.getByText('Evidence').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Fact')).toHaveFocus();
    expect(highlight).toHaveBeenLastCalledWith('ev_1');
  });
});
