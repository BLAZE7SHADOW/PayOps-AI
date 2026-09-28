import { describe, expect, it } from 'vitest';
import { checkBatch } from './settlement';
import { gwPayment, merchantRow, settlementLine, settlementRow } from './test-factory';

const merchant = merchantRow();
const lines = (overrideLine?: number) =>
  [500_000, 1_180_000, 250_000].map((amount, i) =>
    settlementLine(gwPayment({ id: `gwp_${i + 1}`, amountMinor: amount }), merchant, {
      lineNo: i + 1,
      ...(overrideLine === i ? { feeBps: 300 } : {}),
    }),
  );

describe('checkBatch (D7)', () => {
  it('matches a batch settled at contract rates', () => {
    const r = checkBatch({ settlement: settlementRow(), lines: lines(), merchant });
    expect(r.diffMinor).toBe(0);
    expect(r.offendingLines).toEqual([]);
    expect(r.hit).toBeNull();
    expect(r.expectedNetMinor).toBe(r.reportedNetMinor);
  });

  it('finds the line charged above contract and sizes the shortfall', () => {
    const r = checkBatch({ settlement: settlementRow(), lines: lines(1), merchant });
    // 300 bps vs 200 bps on ₹11,800: ₹118 extra fee + ₹21.24 GST
    expect(r.diffMinor).toBe(-13_924);
    expect(r.offendingLines.map((o) => o.line.gwPaymentId)).toEqual(['gwp_2']);
    expect(r.offendingLines[0]?.diffMinor).toBe(-13_924);
    expect(r.hit).toMatchObject({
      ruleId: 'D7_SETTLEMENT_DIFF',
      caseType: 'SETTLEMENT_MISMATCH',
      severityFloor: 'MEDIUM',
      primaryEntity: { kind: 'batch', id: 'stb_1' },
      amountMinor: 13_924,
    });
    expect(r.hit?.reason).toBe('Batch net is short by ₹139.24 across 1 line.');
  });

  it('reports an over-settlement too', () => {
    const [a, b] = lines();
    const r = checkBatch({ settlement: settlementRow(), lines: [a!, { ...b!, netMinor: b!.netMinor + 100 }], merchant });
    expect(r.diffMinor).toBe(100);
    expect(r.hit?.reason).toContain('over by ₹1.00');
  });

  it('handles an empty batch', () => {
    expect(checkBatch({ settlement: settlementRow(), lines: [], merchant }).hit).toBeNull();
  });
});
