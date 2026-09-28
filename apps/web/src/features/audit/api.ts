import type { AuditEventItem } from '@payops/shared';
import { qk, type AuditFilters } from '../../lib/query-keys';
import { useCursorList } from '../../lib/use-cursor-list';

export function useAudit(f: AuditFilters) {
  return useCursorList<AuditEventItem>(qk.audit(f), '/api/audit', { caseId: f.caseId, entityId: f.entityId }, 50);
}
