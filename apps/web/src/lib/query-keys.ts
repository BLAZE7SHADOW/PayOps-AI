import type { CaseListQuery, PaymentListQuery } from '@payops/shared';

export type PaymentFilters = Pick<PaymentListQuery, 'q' | 'gatewayStatus' | 'orderStatus' | 'mismatchOnly'>;
export type CaseFilters = Pick<CaseListQuery, 'scope' | 'type' | 'severity'> & { q?: string };
export interface AuditFilters {
  caseId?: string;
  entityId?: string;
}

/** Every query key starts with its resource so realtime events can invalidate a whole resource. */
export const qk = {
  overview: () => ['overview'] as const,
  payments: {
    all: ['payments'] as const,
    list: (f: PaymentFilters) => ['payments', 'list', f] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },
  cases: {
    all: ['cases'] as const,
    list: (f: CaseFilters) => ['cases', 'list', f] as const,
    detail: (id: string) => ['cases', 'detail', id] as const,
  },
  audit: (f: AuditFilters) => ['audit', f] as const,
  scenarios: () => ['simulator', 'scenarios'] as const,
};
