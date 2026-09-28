import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoAccount } from '@payops/shared';
import { jsonResponse, renderApp } from '../../test/render';
import { LoginPage } from './LoginPage';

const accounts: DemoAccount[] = [
  { email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS', label: 'Ops analyst' },
  { email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER', label: 'Ops manager' },
  { email: 'viewer@payops.dev', name: 'Kabir Shah', role: 'VIEWER', label: 'Viewer' },
];

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('renders the sign-in form and one button per demo account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/auth/me') ? jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401) : jsonResponse(accounts),
      ),
    );
    renderApp(<LoginPage />, { route: '/login' });
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Ananya Rao/ })).toHaveTextContent('Continue as Ops analyst · Ananya Rao');
    expect(screen.getByRole('button', { name: /Meera Iyer/ })).toHaveTextContent('Continue as Ops manager · Meera Iyer');
    expect(screen.getByRole('button', { name: /Kabir Shah/ })).toHaveTextContent('Continue as Viewer · Kabir Shah');
  });

  it('hides the demo section when the server is not in demo mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: 'No' } }, 404)));
    renderApp(<LoginPage />, { route: '/login' });
    await vi.waitFor(() => expect(screen.queryByText('Demo accounts')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Continue as/ })).not.toBeInTheDocument();
  });
});
