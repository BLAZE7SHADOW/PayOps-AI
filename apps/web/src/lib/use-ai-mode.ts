import { useQuery } from '@tanstack/react-query';
import type { AiMode } from '@payops/shared';
import { api } from './api';

/** The server's AI mode, from the public health endpoint. Undefined while loading or if it is unreachable. */
export function useAiMode(): AiMode | undefined {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api<{ aiMode?: AiMode }>('/api/health', { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data?.aiMode;
}
