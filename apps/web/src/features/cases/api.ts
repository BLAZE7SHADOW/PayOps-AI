import { useQuery } from '@tanstack/react-query';
import type { CaseDetail } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useCase(id: string) {
  return useQuery({
    queryKey: qk.cases.detail(id),
    queryFn: ({ signal }) => api<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`, { signal }),
  });
}
