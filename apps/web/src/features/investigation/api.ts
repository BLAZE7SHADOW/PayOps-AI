import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRunItem, AgentStepItem, Page, RunStatus } from '@payops/shared';
import { api, toQueryString } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export const activeRun = (status: RunStatus) => ['INVESTIGATING', 'EXECUTING', 'VALIDATING'].includes(status);

export function useRuns(caseId: string) {
  return useQuery({
    queryKey: qk.runs.list(caseId),
    queryFn: ({ signal }) => api<Page<AgentRunItem>>(`/api/runs${toQueryString({ caseId, limit: 100 })}`, { signal }),
    // Also catches the final snapshot, which is committed after the last step event.
    refetchInterval: (q) => q.state.data?.items.some((r) => activeRun(r.status)) ? 1500 : false,
  });
}

export function useRunSteps(run: AgentRunItem | undefined) {
  return useQuery({
    queryKey: qk.runs.steps(run?.id ?? ''),
    queryFn: ({ signal }) => api<Page<AgentStepItem>>(`/api/runs/${encodeURIComponent(run!.id)}/steps`, { signal }),
    enabled: Boolean(run),
    refetchInterval: run && activeRun(run.status) ? 1500 : false,
  });
}

export function useStartRun(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ runId: string }>(`/api/cases/${encodeURIComponent(caseId)}/runs`, { method: 'POST' }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.runs.all }),
        qc.invalidateQueries({ queryKey: qk.cases.detail(caseId) }),
      ]);
    },
  });
}
