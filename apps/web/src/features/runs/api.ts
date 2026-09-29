import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRunItem, DiagnosisFeedbackBody, DiagnosisFeedbackItem, Page, RunStatus } from '@payops/shared';
import { api, toQueryString } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { activeRun } from '../investigation/api';

export function useRunIndex(status: RunStatus | undefined) {
  return useQuery({
    queryKey: qk.runs.index(status ?? 'ALL'),
    queryFn: ({ signal }) => api<Page<AgentRunItem>>(`/api/runs${toQueryString({ status, limit: 100 })}`, { signal }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => activeRun(r.status)) ? 2000 : false),
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: qk.runs.detail(id),
    queryFn: ({ signal }) => api<AgentRunItem>(`/api/runs/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: (q) => (q.state.data && activeRun(q.state.data.status) ? 1500 : false),
  });
}

export function useRunFeedback(runId: string) {
  return useQuery({
    queryKey: qk.runs.feedback(runId),
    queryFn: ({ signal }) => api<Page<DiagnosisFeedbackItem>>(`/api/runs/${encodeURIComponent(runId)}/feedback`, { signal }),
  });
}

export function useSubmitFeedback(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DiagnosisFeedbackBody) =>
      api<DiagnosisFeedbackItem>(`/api/runs/${encodeURIComponent(runId)}/feedback`, { method: 'PUT', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.runs.feedback(runId) });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
