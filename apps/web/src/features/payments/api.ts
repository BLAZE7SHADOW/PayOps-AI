import { useQuery } from '@tanstack/react-query';
import type { PaymentDetail, PaymentListItem } from '@payops/shared';
import { api } from '../../lib/api';
import { qk, type PaymentFilters } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function usePayments(f: PaymentFilters) {
  return useCursorList<PaymentListItem>(qk.payments.list(f), '/api/payments', {
    q: f.q,
    gatewayStatus: f.gatewayStatus,
    orderStatus: f.orderStatus,
    mismatchOnly: f.mismatchOnly ? 'true' : undefined,
  });
}

export function usePayment(id: string | undefined) {
  return useQuery({
    queryKey: qk.payments.detail(id ?? ''),
    queryFn: ({ signal }) => api<PaymentDetail>(`/api/payments/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}
