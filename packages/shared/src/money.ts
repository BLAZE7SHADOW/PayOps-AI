/**
 * Money helpers. All money in PayOps is stored as integer minor units (paise) in fields
 * named `*Minor`. Floats never enter money paths; formatting happens only here.
 */

export type Currency = 'INR';

const PAISE_PER_RUPEE = 100;

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: Currency, withSymbol: boolean): Intl.NumberFormat {
  const key = `${currency}:${withSymbol}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-IN', {
      style: withSymbol ? 'currency' : 'decimal',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f;
}

export function assertMinor(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, got ${value}`);
  }
}

/**
 * Parse a rupee amount ("12499", "12,499.5", "12499.50") into paise without float math.
 * Throws on anything that is not a plain decimal with at most 2 fraction digits.
 */
export function toMinor(rupees: string | number): number {
  const raw = typeof rupees === 'number' ? rupees.toFixed(2) : rupees.replace(/[,\s₹]/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new TypeError(`Invalid rupee amount: ${String(rupees)}`);
  const [, sign, whole = '0', frac = ''] = match;
  const minor = Number(whole) * PAISE_PER_RUPEE + Number(frac.padEnd(2, '0'));
  assertMinor(minor);
  return sign ? -minor : minor;
}

/** "₹12,499.00" (Indian digit grouping). */
export function formatMoney(minor: number, opts: { symbol?: boolean; currency?: Currency } = {}): string {
  assertMinor(minor);
  const { symbol = true, currency = 'INR' } = opts;
  // Division by 100 of a safe integer is exact enough for display (max 2 decimals).
  return formatter(currency, symbol).format(minor / PAISE_PER_RUPEE);
}

/** Compact form for dense UI: ₹4.2 Cr, ₹12.5 L, ₹12,499. */
export function formatMoneyCompact(minor: number): string {
  assertMinor(minor);
  const rupees = Math.trunc(minor / PAISE_PER_RUPEE);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${trimDecimal(abs / 1_00_00_000)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${trimDecimal(abs / 1_00_000)} L`;
  return `${sign}₹${new Intl.NumberFormat('en-IN').format(abs)}`;
}

function trimDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

export const AMOUNT_BANDS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type AmountBand = (typeof AMOUNT_BANDS)[number];

/** Bands from docs/04-data-model.md: LOW < ₹1,000 ≤ MEDIUM < ₹10,000 ≤ HIGH < ₹50,000 ≤ CRITICAL */
export const AMOUNT_BAND_THRESHOLDS_MINOR = {
  MEDIUM: 1_000_00,
  HIGH: 10_000_00,
  CRITICAL: 50_000_00,
} as const;

export function amountBand(minor: number): AmountBand {
  assertMinor(minor);
  const abs = Math.abs(minor);
  if (abs >= AMOUNT_BAND_THRESHOLDS_MINOR.CRITICAL) return 'CRITICAL';
  if (abs >= AMOUNT_BAND_THRESHOLDS_MINOR.HIGH) return 'HIGH';
  if (abs >= AMOUNT_BAND_THRESHOLDS_MINOR.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** Basis-point fee on an amount, rounded half-up to the nearest paisa. Integer-only. */
export function bpsOf(minor: number, bps: number): number {
  assertMinor(minor);
  assertMinor(bps, 'bps');
  return Math.floor((minor * bps + 5_000) / 10_000);
}
