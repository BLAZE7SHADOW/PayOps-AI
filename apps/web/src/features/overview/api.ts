import { useQuery } from '@tanstack/react-query';
import type { OverviewMetrics } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useOverview() {
  return useQuery({ queryKey: qk.overview(), queryFn: ({ signal }) => api<OverviewMetrics>('/api/overview', { signal }) });
}
