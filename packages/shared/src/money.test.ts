import { describe, expect, it } from 'vitest';
import { amountBand, bpsOf, formatMoney, formatMoneyCompact, toMinor } from './money';

describe('money', () => {
  it('parses rupees into paise without float drift', () => {
    expect(toMinor('12499')).toBe(1_249_900);
    expect(toMinor('12,499.5')).toBe(1_249_950);
    expect(toMinor('0.1')).toBe(10);
    expect(toMinor('₹78,000.00')).toBe(7_800_000);
    expect(toMinor(0.29)).toBe(29);
  });

  it('rejects malformed input', () => {
    expect(() => toMinor('12.345')).toThrow();
    expect(() => toMinor('abc')).toThrow();
  });

  it('formats with Indian grouping', () => {
    expect(formatMoney(1_249_900)).toBe('₹12,499.00');
    expect(formatMoney(1_00_00_000_00)).toBe('₹1,00,00,000.00');
    expect(formatMoney(1_249_900, { symbol: false })).toBe('12,499.00');
  });

  it('formats compact amounts', () => {
    expect(formatMoneyCompact(4_20_00_000_00)).toBe('₹4.2 Cr');
    expect(formatMoneyCompact(12_50_000_00)).toBe('₹12.5 L');
    expect(formatMoneyCompact(12_499_00)).toBe('₹12,499');
  });

  it('bands amounts at the documented thresholds', () => {
    expect(amountBand(999_99)).toBe('LOW');
    expect(amountBand(1_000_00)).toBe('MEDIUM');
    expect(amountBand(10_000_00)).toBe('HIGH');
    expect(amountBand(50_000_00)).toBe('CRITICAL');
  });

  it('computes basis-point fees in integers', () => {
    expect(bpsOf(1_249_900, 200)).toBe(24_998);
    expect(bpsOf(101, 50)).toBe(1);
  });

  it('refuses non-integer minor amounts', () => {
    expect(() => formatMoney(10.5)).toThrow();
  });
});
