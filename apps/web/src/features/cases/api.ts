import { useQuery } from '@tanstack/react-query';
import type { CaseDetail, CaseSourceRecords } from '@payops/shared';
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
