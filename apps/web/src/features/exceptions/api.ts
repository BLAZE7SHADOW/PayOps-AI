import type { CaseListItem } from '@payops/shared';
import { qk, type CaseFilters } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function useCases(f: CaseFilters) {
  // `q` (a display id like PAY-0042) is not part of CaseListQuery yet; the server ignores
  // unknown params, and the page also filters loaded rows by it.
  return useCursorList<CaseListItem>(qk.cases.list(f), '/api/cases', { scope: f.scope, type: f.type, severity: f.severity, q: f.q }, 50);
}
