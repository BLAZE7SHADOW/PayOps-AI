import type { CaseDetail, ResolutionItem } from '@payops/shared';

/**
 * The resolution an operator may undo, or null (D070). Mirrors the server's checks: a resolved case,
 * its latest resolution passed validation, and one of its steps posted a capture to the ledger.
 * The server decides in the end; this only decides whether to show the button.
 */
export function undoableResolution(c: CaseDetail): ResolutionItem | null {
  if (c.status !== 'RESOLVED') return null;
  const latest = [...c.resolutionView.resolutions].sort((a, b) => b.attempt - a.attempt)[0];
  if (!latest || latest.status !== 'VALIDATED' || latest.validation?.verdict !== 'PASS') return null;
  const posted = latest.executions.some((e) => e.type === 'POST_LEDGER_ENTRY' && e.status === 'SUCCEEDED');
  return posted ? latest : null;
}
