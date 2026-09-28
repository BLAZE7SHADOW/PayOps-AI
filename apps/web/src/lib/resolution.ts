/** Display helpers for the resolution spine: tiers, statuses, verdicts, params. Pure functions. */
import {
  ACTION_META,
  POLICY_RULES,
  formatMoney,
  type ApprovalStatus,
  type CatalogAction,
  type ExecutionStepStatus,
  type PolicyTier,
  type ResolutionItem,
  type ResolutionStatus,
  type ValidationCheck,
  type ValidationVerdict,
} from '@payops/shared';
import type { Tone } from './status';

const TIER: Record<PolicyTier, Tone> = { AUTO: 'ok', OPS: 'warn', MANAGER: 'warn', BLOCKED: 'bad' };
const VERDICT: Record<ValidationVerdict, Tone> = { PASS: 'ok', PARTIAL: 'warn', FAIL: 'bad' };
const RESOLUTION: Record<ResolutionStatus, Tone> = {
  BLOCKED: 'bad',
  AWAITING_APPROVAL: 'warn',
  REJECTED: 'bad',
  ESCALATED: 'warn',
  EXECUTING: 'accent',
  EXECUTION_FAILED: 'bad',
  VALIDATED: 'ok',
};
const APPROVAL: Record<ApprovalStatus, Tone> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'bad', ESCALATED: 'warn' };
const STEP: Record<ExecutionStepStatus, Tone> = { STARTED: 'accent', SUCCEEDED: 'ok', FAILED: 'bad', SKIPPED: 'neutral' };

export const resolutionTone = {
  tier: (t: PolicyTier): Tone => TIER[t],
  verdict: (v: ValidationVerdict): Tone => VERDICT[v],
  status: (s: ResolutionStatus): Tone => RESOLUTION[s],
  approval: (s: ApprovalStatus): Tone => APPROVAL[s],
  step: (s: ExecutionStepStatus): Tone => STEP[s],
};

/** The primary button in the resolve drawer says exactly what will happen on submit. */
export function submitLabel(tier: PolicyTier | null | undefined, pending = false): string {
  switch (tier) {
    case 'AUTO':
      return pending ? 'Executing…' : 'Execute now';
    case 'OPS':
      return pending ? 'Requesting approval…' : 'Request OPS approval';
    case 'MANAGER':
      return pending ? 'Requesting approval…' : 'Request manager approval';
    case 'BLOCKED':
      return 'Blocked by policy';
    default:
      return 'Checking policy';
  }
}

export function ruleCondition(ruleId: string): string {
  return POLICY_RULES.find((r) => r.id === ruleId)?.condition ?? 'Unknown rule';
}

/** "P3 · Refunds over ₹10,000 → MANAGER" */
export function ruleLine(ruleId: string, tier: PolicyTier | string): string {
  return `${ruleId} · ${ruleCondition(ruleId)} → ${tier}`;
}

/** "Attempt 2 · PASS" when verified, otherwise the attempt's status. */
export function attemptLabel(r: ResolutionItem): string {
  const outcome = r.validation ? r.validation.verdict : r.status.replace(/_/g, ' ');
  return `Attempt ${r.attempt} · ${outcome}`;
}

export function checkCounts(checks: readonly ValidationCheck[]) {
  const failed = checks.filter((c) => !c.pass).length;
  return { total: checks.length, failed, passed: checks.length - failed };
}

/** "Verified: PASS · 6 of 6 checks" / "Verified: FAIL · 1 of 5 checks failed" */
export function verdictLine(verdict: ValidationVerdict, checks: readonly ValidationCheck[]): string {
  return `Verified: ${verdict} · ${verdictDetail(checks)}`;
}

/** "6 of 6 checks" when all pass, otherwise "1 of 5 checks failed". */
export function verdictDetail(checks: readonly ValidationCheck[]): string {
  const { total, failed, passed } = checkCounts(checks);
  return failed === 0 ? `${passed} of ${total} checks` : `${failed} of ${total} checks failed`;
}

/** "184 ms", "1.2 s", "2 min 4 s". Code does the date math; nothing else does. */
export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return '–';
  const ms = Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const min = Math.floor(ms / 60_000);
  return `${min} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export interface ParamPart {
  key: string;
  value: string;
}

/** Parameters as key/value pairs; amounts formatted as money, never raw paise. */
export function actionParams(action: CatalogAction): ParamPart[] {
  return Object.entries(action.params as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, v]) => ({
      key: key === 'amountMinor' ? 'amount' : key,
      value: key === 'amountMinor' && typeof v === 'number' ? formatMoney(v) : String(v),
    }));
}

export function actionLabel(action: CatalogAction): string {
  return ACTION_META[action.type].label;
}

/** "Refund customer · Post capture to ledger" */
export function actionsSummary(actions: readonly CatalogAction[]): string {
  return actions.map(actionLabel).join(' · ');
}
