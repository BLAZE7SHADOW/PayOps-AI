import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('asks for a code when the password step says one is needed, then signs in', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith('/api/auth/login')) return jsonResponse({ mfaRequired: true, challenge: 'chal-1' });
        if (url.endsWith('/api/auth/login/mfa')) return jsonResponse({ id: 'u1', email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER' });
        if (url.endsWith('/api/auth/me')) return jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401);
        return jsonResponse([]);
      }),
    );
    const user = userEvent.setup();
    renderApp(<LoginPage />, { route: '/login' });
    await user.type(screen.getByLabelText('Email'), 'manager@payops.dev');
    await user.type(screen.getByLabelText('Password'), 'payops-demo');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const codeField = await screen.findByLabelText('6-digit code');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    const verify = screen.getByRole('button', { name: 'Verify and sign in' });
    expect(verify).toBeDisabled();
    await user.type(codeField, '123 456');
    expect(verify).toBeEnabled();
    await user.click(verify);
    await waitFor(() => expect(posts.map((p) => p.url.replace(/^.*\/api/, '/api'))).toEqual(['/api/auth/login', '/api/auth/login/mfa']));
    expect(posts[1]!.body).toEqual({ challenge: 'chal-1', code: '123 456' });
  });

  it('shows the server message for a wrong code and can go back to the password step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return jsonResponse({ mfaRequired: true, challenge: 'chal-1' });
        if (url.endsWith('/api/auth/login/mfa')) return jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'That code is not correct or has already been used' } }, 401);
        if (url.endsWith('/api/auth/me')) return jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401);
        return jsonResponse([]);
      }),
    );
    const user = userEvent.setup();
    renderApp(<LoginPage />, { route: '/login' });
    await user.type(screen.getByLabelText('Email'), 'manager@payops.dev');
    await user.type(screen.getByLabelText('Password'), 'payops-demo');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('That code is not correct or has already been used')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
