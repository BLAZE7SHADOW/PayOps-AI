import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export interface ResetStatus {
  canUndo: boolean;
  snapshotAt: string | null;
}

export function useResetStatus() {
  return useQuery({
    queryKey: ['simulator', 'reset-status'],
    queryFn: ({ signal }) => api<ResetStatus>('/api/simulator/reset-status', { signal }),
  });
}

export function useResetDemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<ResetStatus>('/api/simulator/reset', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useUndoReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<ResetStatus>('/api/simulator/undo-reset', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export interface RecordedRun {
  scenario: string;
  seed: number;
  status: string;
  tier: string | null;
  verdict: string | null;
}

/** Scenario/seed pairs with recorded AI responses (what REPLAY mode can investigate). */
export function useRecordedRuns() {
  return useQuery({
    queryKey: ['simulator', 'recorded'],
    queryFn: ({ signal }) => api<RecordedRun[]>('/api/simulator/recorded', { signal }),
    staleTime: Infinity,
  });
}
