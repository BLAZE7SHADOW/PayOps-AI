/** Short, run-scoped ids (docs/03-agent-system.md §7): "ev_03", "fd_02". Derived from the
 * current state so they stay stable and deterministic across resumes (no closure counters). */
import type { EvidenceItem, Finding } from '@payops/shared';

export function nextEvidenceId(existing: readonly EvidenceItem[]): string {
  return `ev_${String(existing.length + 1).padStart(2, '0')}`;
}

export function nextFindingId(existing: readonly Finding[]): string {
  return `fd_${String(existing.length + 1).padStart(2, '0')}`;
}
