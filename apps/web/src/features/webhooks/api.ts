import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookLogCounts, WebhookLogDetail, WebhookLogItem, WebhookLogStatus } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function useWebhookLog(f: { status?: WebhookLogStatus; event?: string }) {
  return useCursorList<WebhookLogItem>(qk.webhooks.list(f), '/api/webhooks', { status: f.status, event: f.event }, 50);
}

export function useWebhookCounts() {
  return useQuery({ queryKey: qk.webhooks.counts(), queryFn: ({ signal }) => api<WebhookLogCounts>('/api/webhooks/counts', { signal }) });
}

export function useWebhookDetail(id: string | undefined) {
  return useQuery({
    queryKey: qk.webhooks.detail(id ?? ''),
    queryFn: ({ signal }) => api<WebhookLogDetail>(`/api/webhooks/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useReplayWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<WebhookLogDetail>(`/api/webhooks/${encodeURIComponent(id)}/replay`, { method: 'POST', body: {} }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.webhooks.all });
      // A replay can fix a case, so the queue and the audit log may have changed too.
      void qc.invalidateQueries({ queryKey: qk.cases.all });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
