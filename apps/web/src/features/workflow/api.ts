import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HandoffSummary, OperatorNoteBody, OperatorNoteItem, Page, SavedViewBody, SavedViewItem } from '@payops/shared';
import { api, toQueryString } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export function useCaseNotes(caseId: string) {
  return useQuery({
    queryKey: qk.cases.notes(caseId),
    queryFn: ({ signal }) => api<Page<OperatorNoteItem>>(`/api/cases/${encodeURIComponent(caseId)}/notes`, { signal }),
  });
}

export function useAddNote(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OperatorNoteBody) => api<OperatorNoteItem>(`/api/cases/${encodeURIComponent(caseId)}/notes`, { method: 'POST', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.cases.notes(caseId) });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      void qc.invalidateQueries({ queryKey: ['handoff'] });
    },
  });
}

export function useSavedViews() {
  return useQuery({
    queryKey: qk.views(),
    queryFn: ({ signal }) => api<Page<SavedViewItem>>('/api/views', { signal }),
  });
}

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SavedViewBody) => api<SavedViewItem>('/api/views', { method: 'POST', body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.views() }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.views() }),
  });
}

export function useHandoff(hours: number) {
  return useQuery({
    queryKey: qk.handoff(hours),
    queryFn: ({ signal }) => api<HandoffSummary>(`/api/handoff${toQueryString({ hours })}`, { signal }),
  });
}
