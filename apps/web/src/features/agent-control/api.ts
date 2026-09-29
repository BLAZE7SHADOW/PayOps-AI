import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentControlBody, AgentControlItem } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/** Polled so every open tab notices a pause within seconds, without a realtime event. */
export function useAgentControl() {
  return useQuery({
    queryKey: qk.agentControl(),
    queryFn: ({ signal }) => api<AgentControlItem>('/api/agent-control', { signal }),
    refetchInterval: 15_000,
  });
}

export function useSetAgentControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentControlBody) => api<AgentControlItem>('/api/agent-control', { method: 'PUT', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.agentControl() });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
