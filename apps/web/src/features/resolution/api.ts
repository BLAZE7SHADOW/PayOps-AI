import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { CatalogAction, PolicyPreview, ProposeActionsBody, ResolutionItem } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export const PREVIEW_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Live policy preview for the proposal being edited. Debounced on the serialized proposal so a
 * typed amount asks the server once, not per keystroke. `null` actions (invalid form) ask nothing.
 * `settled` is false while the shown preview belongs to an older proposal.
 */
export function usePolicyPreview(caseId: string, actions: CatalogAction[] | null) {
  const key = actions && actions.length ? JSON.stringify(actions) : null;
  const debouncedKey = useDebounced(key, PREVIEW_DEBOUNCE_MS);
  const q = useQuery({
    queryKey: qk.preview(caseId, debouncedKey ?? ''),
    queryFn: ({ signal }) =>
      api<PolicyPreview>(`/api/cases/${encodeURIComponent(caseId)}/actions/preview`, {
        method: 'POST',
        body: { actions: JSON.parse(debouncedKey ?? '[]') as CatalogAction[] },
        signal,
      }),
    enabled: debouncedKey !== null,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const settled = key !== null && key === debouncedKey && q.isSuccess && !q.isPlaceholderData;
  return { ...q, preview: key === null ? undefined : q.data, settled };
}

export function usePropose(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProposeActionsBody) =>
      api<ResolutionItem>(`/api/cases/${encodeURIComponent(caseId)}/actions`, { method: 'POST', body }),
    onSuccess: () => {
      for (const queryKey of [qk.cases.detail(caseId), qk.cases.all, qk.approvals.all, qk.overview(), ['audit']]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}
