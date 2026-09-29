import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecisionBody, ApprovalDetail, ApprovalItem, BulkApprovalBody, BulkApprovalResult } from '@payops/shared';
import { api } from '../../lib/api';
import { qk, type ApprovalScope } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function useApprovals(scope: ApprovalScope) {
  return useCursorList<ApprovalItem>(qk.approvals.list(scope), '/api/approvals', { scope }, 50);
}

export function useApproval(id: string | undefined) {
  return useQuery({
    queryKey: qk.approvals.detail(id ?? ''),
    queryFn: ({ signal }) => api<ApprovalDetail>(`/api/approvals/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useDecide(id: string, caseId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApprovalDecisionBody) =>
      api<ApprovalItem>(`/api/approvals/${encodeURIComponent(id)}/decision`, { method: 'POST', body }),
    onSettled: () => {
      // 409 (already decided) also means our copy is stale, so refresh on error too.
      const keys: ReadonlyArray<readonly unknown[]> = [qk.approvals.all, qk.overview(), qk.cases.all, ['audit']];
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
      if (caseId) void qc.invalidateQueries({ queryKey: qk.cases.detail(caseId) });
    },
  });
}

export function useBulkApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkApprovalBody) => api<BulkApprovalResult>('/api/approvals/bulk-approve', { method: 'POST', body }),
    onSettled: () => {
      const keys: ReadonlyArray<readonly unknown[]> = [qk.approvals.all, qk.overview(), qk.cases.all, ['audit']];
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    },
  });
}
