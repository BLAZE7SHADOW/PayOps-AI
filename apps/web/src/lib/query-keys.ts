import type { ApprovalListQuery, CaseListQuery, PaymentListQuery } from '@payops/shared';

export type PaymentFilters = Pick<PaymentListQuery, 'q' | 'gatewayStatus' | 'orderStatus' | 'mismatchOnly'>;
export type CaseFilters = Pick<CaseListQuery, 'scope' | 'type' | 'severity'> & { q?: string; assigneeId?: string; overdue?: boolean };
export interface AuditFilters {
  caseId?: string;
  entityId?: string;
}
export type ApprovalScope = ApprovalListQuery['scope'];

/** Every query key starts with its resource so realtime events can invalidate a whole resource. */
export const qk = {
  session: () => ['session'] as const,
  demoAccounts: () => ['session', 'demo-accounts'] as const,
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
    records: (id: string) => ['cases', 'records', id] as const,
    notes: (id: string) => ['cases', 'notes', id] as const,
  },
  views: () => ['views'] as const,
  handoff: (hours: number) => ['handoff', hours] as const,
  /** Policy previews are keyed by the exact proposal so an unchanged selection is never re-asked. */
  preview: (caseId: string, actionsKey: string) => ['preview', caseId, actionsKey] as const,
  approvals: {
    all: ['approvals'] as const,
    list: (scope: ApprovalScope) => ['approvals', 'list', scope] as const,
    detail: (id: string) => ['approvals', 'detail', id] as const,
  },
  runs: {
    all: ['runs'] as const,
    list: (caseId: string) => ['runs', 'list', caseId] as const,
    steps: (id: string) => ['runs', 'steps', id] as const,
    index: (status: string) => ['runs', 'index', status] as const,
    detail: (id: string) => ['runs', 'detail', id] as const,
    feedback: (id: string) => ['runs', 'feedback', id] as const,
  },
  policy: () => ['policy'] as const,
  agentControl: () => ['agent-control'] as const,
  audit: (f: AuditFilters) => ['audit', f] as const,
  webhooks: {
    all: ['webhooks'] as const,
    list: (f: { status?: string; event?: string }) => ['webhooks', 'list', f] as const,
    counts: () => ['webhooks', 'counts'] as const,
    detail: (id: string) => ['webhooks', 'detail', id] as const,
  },
  scenarios: () => ['simulator', 'scenarios'] as const,
};
