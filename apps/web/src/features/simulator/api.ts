import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GenerateScenarioBody, GenerateScenarioResult } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useGenerateScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateScenarioBody) => api<GenerateScenarioResult>('/api/simulator/scenarios', { method: 'POST', body }),
    onSuccess: () => {
      for (const key of [qk.cases.all, qk.payments.all, qk.overview(), ['audit']]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useResetDemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<unknown>('/api/simulator/reset', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}
