import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecurityOverview } from '@payops/shared';
import { jsonResponse, renderApp } from '../../test/render';
import { SecurityPage } from './SecurityPage';

afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<SecurityOverview['sessions'][number]> = {}): SecurityOverview['sessions'][number] => ({
  id: 'ses_1',
  createdAt: '2026-09-29T10:00:00.000Z',
  lastSeenAt: '2026-09-29T10:30:00.000Z',
  expiresAt: '2026-09-29T18:00:00.000Z',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  mfaVerified: false,
  current: true,
  ...over,
});

/** A tiny fake of the auth API; the returned object records the POSTs it saw. */
function fakeApi(state: SecurityOverview) {
  const posts: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^.*\/api/, '/api');
      if (init?.method === 'POST') {
        posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
        if (path === '/api/auth/mfa/setup') return jsonResponse({ secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', otpauthUrl: 'otpauth://totp/PayOps%20AI:ops@payops.dev?secret=ABCD' });
        if (path === '/api/auth/mfa/enable') {
          state.mfaEnabled = true;
          return jsonResponse({ mfaEnabled: true, otherSessionsRevoked: 0 });
        }
        if (path === '/api/auth/mfa/disable') {
          state.mfaEnabled = false;
          return jsonResponse({ mfaEnabled: false });
        }
        return jsonResponse({ revoked: true });
      }
      return jsonResponse(state);
    }),
  );
  return posts;
}

describe('SecurityPage', () => {
  it('lists sessions, marks this device, and offers sign out only for the others', async () => {
    fakeApi({
      mfaEnabled: false,
      mfaRecommended: false,
      sessions: [session(), session({ id: 'ses_2', current: false, ip: '198.51.100.4', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' })],
    });
    renderApp(<SecurityPage />);
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('THIS DEVICE')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Sign out .* from / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sign out 1 other browser' })).toBeEnabled();
  });

  it('signs out one browser by id', async () => {
    const posts = fakeApi({ mfaEnabled: false, mfaRecommended: false, sessions: [session(), session({ id: 'ses_2', current: false })] });
    const user = userEvent.setup();
    renderApp(<SecurityPage />);
    await user.click(await screen.findByRole('button', { name: /^Sign out .* from / }));
    await waitFor(() => expect(posts).toContainEqual({ path: '/api/auth/sessions/ses_2/revoke', body: {} }));
  });

  it('disables the bulk action when there is only this browser', async () => {
    fakeApi({ mfaEnabled: false, mfaRecommended: false, sessions: [session()] });
    renderApp(<SecurityPage />);
    expect(await screen.findByRole('button', { name: 'No other browsers' })).toBeDisabled();
  });

  it('walks through turning MFA on: key shown, code confirms, panel shows ON', async () => {
    const posts = fakeApi({ mfaEnabled: false, mfaRecommended: true, sessions: [session()] });
    const user = userEvent.setup();
    renderApp(<SecurityPage />);
    expect(await screen.findByText('Your role approves higher-risk actions. Turn this on.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByLabelText('Setup key')).toHaveTextContent('ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567');
    const confirm = screen.getByRole('button', { name: 'Confirm and turn on' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(confirm);
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/auth/mfa/setup', '/api/auth/mfa/enable']));
    expect(posts[1]!.body).toEqual({ code: '123456' });
    expect(await screen.findByText('ON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('asks for a code before turning MFA off', async () => {
    const posts = fakeApi({ mfaEnabled: true, mfaRecommended: false, sessions: [session()] });
    const user = userEvent.setup();
    renderApp(<SecurityPage />);
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const off = screen.getByRole('button', { name: 'Turn off' });
    expect(off).toBeDisabled();
    await user.type(screen.getByLabelText('6-digit code'), '654321');
    await user.click(off);
    await waitFor(() => expect(posts).toContainEqual({ path: '/api/auth/mfa/disable', body: { code: '654321' } }));
  });

  it('shows the error state with the request details when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'INTERNAL', message: 'Boom' } }, 500)));
    renderApp(<SecurityPage />);
    expect(await screen.findByText('Could not load security settings.')).toBeInTheDocument();
  });
});
