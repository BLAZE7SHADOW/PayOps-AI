import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CaseDetail, CaseListItem, CaseSourceRecords } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useCase(id: string) {
  return useQuery({
    queryKey: qk.cases.detail(id),
    queryFn: ({ signal }) => api<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useCaseSourceRecords(id: string, live = false) {
  return useQuery({
    // While a run is active the records change under the operator, so keep the snapshot fresh.
    refetchInterval: live ? 3000 : false,
    queryKey: qk.cases.records(id),
    queryFn: ({ signal }) => api<CaseSourceRecords>(`/api/cases/${encodeURIComponent(id)}/records`, { signal }),
  });
}

/** Assign a case to a user, or clear the assignee with null. The server audits the change. */
export function useAssignCase(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assigneeId: string | null) =>
      api<CaseListItem>(`/api/cases/${encodeURIComponent(caseId)}/assignee`, { method: 'PUT', body: { assigneeId } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.cases.all });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
