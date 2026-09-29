import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaSetupResponse, SecurityOverview } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useSecurity() {
  return useQuery({ queryKey: qk.security(), queryFn: ({ signal }) => api<SecurityOverview>('/api/auth/security', { signal }) });
}

function useSecurityMutation<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.security() });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const useMfaSetup = () => useSecurityMutation(() => post<MfaSetupResponse>('/api/auth/mfa/setup'));
export const useMfaEnable = () => useSecurityMutation((code: string) => post<{ mfaEnabled: true; otherSessionsRevoked: number }>('/api/auth/mfa/enable', { code }));
export const useMfaDisable = () => useSecurityMutation((code: string) => post<{ mfaEnabled: false }>('/api/auth/mfa/disable', { code }));
export const useRevokeSession = () => useSecurityMutation((id: string) => post<{ revoked: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`));
export const useRevokeOtherSessions = () => useSecurityMutation(() => post<{ revoked: number }>('/api/auth/sessions/revoke-others'));
