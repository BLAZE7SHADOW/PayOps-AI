import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isMfaChallenge, type DemoAccount, type LoginBody, type LoginResponse, type MfaLoginBody, type SessionUser } from '@payops/shared';
import { ApiError, api } from './api';
import { qk } from './query-keys';

/**
 * The signed-in user, or null when there is no session. The cookie is httpOnly, so the only way to
 * know is to ask the server. Any 401 elsewhere sets this to null (see providers.tsx), which sends
 * the guard back to /login.
 */
export function useSession() {
  return useQuery({
    queryKey: qk.session(),
    queryFn: async ({ signal }) => {
      try {
        return await api<SessionUser>('/api/auth/me', { signal });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
  });
}

/** Convenience for components inside the guard, where a user always exists. */
export function useUser(): SessionUser | null {
  return useSession().data ?? null;
}

export function useDemoAccounts() {
  return useQuery({
    queryKey: qk.demoAccounts(),
    // 404/403 means the server is not in demo mode: show no demo accounts, not an error.
    queryFn: async ({ signal }) => {
      try {
        return await api<DemoAccount[]>('/api/auth/demo-accounts', { signal });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return [];
        throw err;
      }
    },
    staleTime: Infinity,
  });
}

/** Keeps the cache in step with a sign-in that produced a session (not a code challenge). */
function useSignedIn() {
  const qc = useQueryClient();
  return (user: SessionUser) => {
    // Drop anything cached for a previous user before the app renders for this one.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
    qc.setQueryData(qk.session(), user);
  };
}

/** A password step can end in a session or in "now enter your code"; only a session is cached. */
function usePasswordStep<TBody>(path: string) {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: TBody) => api<LoginResponse>(path, { method: 'POST', body }),
    onSuccess: (res) => {
      if (!isMfaChallenge(res)) signedIn(res);
    },
  });
}

export const useLogin = () => usePasswordStep<LoginBody>('/api/auth/login');
export const useDemoLogin = () => usePasswordStep<{ email: string }>('/api/auth/demo-login');

export function useMfaLogin() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: MfaLoginBody) => api<SessionUser>('/api/auth/login/mfa', { method: 'POST', body }),
    onSuccess: signedIn,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    // Sign out locally even if the request fails; the cookie expires on its own.
    onSettled: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      qc.setQueryData(qk.session(), null);
    },
  });
}

/** Only same-app paths are allowed as a post-login destination (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/overview';
  return next;
}
