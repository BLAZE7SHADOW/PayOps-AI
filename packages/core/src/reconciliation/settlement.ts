/**
 * D7: settlement batch check. Recomputes each line's net from the merchant contract and compares
 * the batch total with what the gateway reported. Pure; the service loads the inputs.
 */
import { formatMoney } from '@payops/shared';
import type { MerchantRow, SettlementRow } from '../db/rows';
import type { GatewaySettlementLine } from '../ports/gateway';
import { expectedFee, sum, type FeeBreakdown } from './facts';
import type { RuleHit } from './rules';

export interface OffendingLine {
  line: GatewaySettlementLine;
  expected: FeeBreakdown;
  /** reported net minus expected net for this line (negative = merchant short-paid). */
  diffMinor: number;
}

export interface BatchCheck {
  batchId: string;
  expectedNetMinor: number;
  reportedNetMinor: number;
  /** reported − expected. Negative means the settlement is short. */
  diffMinor: number;
  offendingLines: OffendingLine[];
  hit: RuleHit | null;
}

export function checkBatch(input: {
  settlement: Pick<SettlementRow, 'id'>;
  lines: readonly GatewaySettlementLine[];
  merchant: Pick<MerchantRow, 'feeBps' | 'feeFixedMinor' | 'taxBps'>;
}): BatchCheck {
  const { settlement, merchant } = input;
  const lines = [...input.lines].sort((a, b) => a.lineNo - b.lineNo);
  const offendingLines: OffendingLine[] = [];
  let expectedNetMinor = 0;
  for (const line of lines) {
    const expected = expectedFee(line.grossMinor, merchant);
    expectedNetMinor += expected.netMinor;
    if (line.netMinor !== expected.netMinor) {
      offendingLines.push({ line, expected, diffMinor: line.netMinor - expected.netMinor });
    }
  }
  const reportedNetMinor = sum(lines.map((l) => l.netMinor));
  const diffMinor = reportedNetMinor - expectedNetMinor;
  const abs = Math.abs(diffMinor);
  const hit: RuleHit | null =
    diffMinor === 0
      ? null
      : {
          ruleId: 'D7_SETTLEMENT_DIFF',
          caseType: 'SETTLEMENT_MISMATCH',
          severityFloor: 'MEDIUM',
          primaryEntity: { kind: 'batch', id: settlement.id },
          amountMinor: abs,
          reason: `Batch net is ${diffMinor < 0 ? 'short' : 'over'} by ${formatMoney(abs)} across ${offendingLines.length} line${offendingLines.length === 1 ? '' : 's'}.`,
        };
  return { batchId: settlement.id, expectedNetMinor, reportedNetMinor, diffMinor, offendingLines, hit };
}
