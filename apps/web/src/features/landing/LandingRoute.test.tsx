import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderApp } from '../../test/render';
import { LandingRoute } from './LandingRoute';
import { PrivacyPage } from './PrivacyPage';
import { TermsPage } from './TermsPage';

afterEach(() => vi.unstubAllGlobals());

describe('LandingRoute', () => {
  it('explains the problem, shows the matrix and the demo video, and links to the demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401)));
    const { container } = renderApp(<LandingRoute />, { route: '/' });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('When a customer has paid but your records disagree');
    expect(screen.getAllByRole('link', { name: 'Open the demo' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Watch the 3-minute video' })).toHaveAttribute('href', '#demo');
    expect(screen.getByRole('table', { name: 'State matrix' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'What PayOps AI does' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole('img', { name: /architecture/i })).toBeInTheDocument();
    // The video must not download anything until someone presses play.
    expect(container.querySelector('video')).toHaveAttribute('preload', 'none');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    // No name and no source-code link on the page (D081).
    expect(screen.queryByRole('link', { name: /source code/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Shivam|Satyam|github/i);
  });
});

describe('legal pages', () => {
  it('render their headings without needing a session', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 401)));
    renderApp(<TermsPage />, { route: '/terms' });
    expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeInTheDocument();
    renderApp(<PrivacyPage />, { route: '/privacy' });
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeInTheDocument();
  });
});
