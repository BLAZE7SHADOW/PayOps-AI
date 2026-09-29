import type { CaseListItem } from '@payops/shared';
import { qk, type CaseFilters } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function useCases(f: CaseFilters) {
  // `q` matches a display id (PAY-0042), case id, payment id or order id by prefix on the server.
  return useCursorList<CaseListItem>(qk.cases.list(f), '/api/cases', { scope: f.scope, type: f.type, severity: f.severity, q: f.q, assigneeId: f.assigneeId, overdue: f.overdue }, 50);
}
