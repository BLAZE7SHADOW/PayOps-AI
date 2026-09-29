import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderApp } from '../../test/render';
import { LandingRoute } from './LandingRoute';
import { PrivacyPage } from './PrivacyPage';
import { TermsPage } from './TermsPage';

afterEach(() => vi.unstubAllGlobals());

describe('LandingRoute', () => {
  it('shows the landing page with a demo link to signed-out visitors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401)));
    renderApp(<LandingRoute />, { route: '/' });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Find payments where your systems disagree');
    expect(screen.getByRole('button', { name: 'Open the demo' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
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
