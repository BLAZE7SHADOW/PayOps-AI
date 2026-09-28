/** Pure form logic for "Resolve manually": drafts, validation, and the proposal it produces. */
import { formatMoney, toMinor, type ActionOption, type CatalogAction } from '@payops/shared';

export interface Draft {
  checked: boolean;
  /** Rupees as typed, e.g. "78,000.00". Converted with shared toMinor, never with float math. */
  amount: string;
  reason: string;
}

export interface DraftErrors {
  amount?: string;
  reason?: string;
}

export const RATIONALE_MIN = 10;
export const RATIONALE_MAX = 1000;

function param(action: CatalogAction, key: 'amountMinor' | 'reason'): unknown {
  return (action.params as Record<string, unknown>)[key];
}

export function initialDrafts(options: readonly ActionOption[]): Draft[] {
  return options.map((o) => {
    const amount = param(o.action, 'amountMinor');
    const reason = param(o.action, 'reason');
    return {
      checked: o.available && o.recommended,
      amount: typeof amount === 'number' ? formatMoney(amount, { symbol: false }) : '',
      reason: typeof reason === 'string' ? reason : '',
    };
  });
}

/** Parse a typed rupee amount into paise, or explain what is wrong with it. */
export function parseAmount(raw: string, maxMinor: number | null): { minor: number } | { error: string } {
  if (!raw.trim()) return { error: 'Enter an amount.' };
  let minor: number;
  try {
    minor = toMinor(raw.trim());
  } catch {
    return { error: 'Enter an amount like 12,499.00.' };
  }
  if (minor <= 0) return { error: 'Amount must be more than ₹0.00.' };
  if (maxMinor !== null && minor > maxMinor) return { error: `Up to ${formatMoney(maxMinor)}, the refundable balance.` };
  return { minor };
}

export function validateDraft(option: ActionOption, draft: Draft): DraftErrors {
  if (!draft.checked) return {};
  const errors: DraftErrors = {};
  if (option.editable.includes('amountMinor')) {
    const parsed = parseAmount(draft.amount, option.maxAmountMinor);
    if ('error' in parsed) errors.amount = parsed.error;
  }
  if (option.editable.includes('reason')) {
    const max = option.type === 'ESCALATE_TO_HUMAN' ? 300 : 200;
    const len = draft.reason.trim().length;
    if (len < 3) errors.reason = 'Give a reason of at least 3 characters.';
    else if (len > max) errors.reason = `Keep the reason under ${max} characters.`;
  }
  return errors;
}

export function rationaleError(text: string): string | null {
  const len = text.trim().length;
  if (len < RATIONALE_MIN) return `Explain the fix in at least ${RATIONALE_MIN} characters.`;
  if (len > RATIONALE_MAX) return `Keep the rationale under ${RATIONALE_MAX} characters.`;
  return null;
}

/**
 * The proposal the form currently describes, in option order. Returns null when nothing is selected
 * or a selected action has an invalid field (so no preview is requested for an impossible proposal).
 */
export function buildActions(options: readonly ActionOption[], drafts: readonly Draft[]): CatalogAction[] | null {
  const out: CatalogAction[] = [];
  for (const [i, o] of options.entries()) {
    const d = drafts[i];
    if (!d?.checked || !o.available) continue;
    const errors = validateDraft(o, d);
    if (errors.amount || errors.reason) return null;
    const params: Record<string, unknown> = { ...(o.action.params as Record<string, unknown>) };
    if (o.editable.includes('amountMinor')) {
      const parsed = parseAmount(d.amount, o.maxAmountMinor);
      if ('minor' in parsed) params.amountMinor = parsed.minor;
    }
    if (o.editable.includes('reason')) params.reason = d.reason.trim();
    out.push({ type: o.action.type, params } as CatalogAction);
  }
  return out.length ? out : null;
}
