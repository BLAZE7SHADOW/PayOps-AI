/** Builds the code-computed CaseBrief fed to J6 and, on the full path, the LLM (docs/03 §4a, §8). */
import type { CaseState } from '@payops/core';
import { amountBand, type CaseBrief } from '@payops/shared';

export function buildCaseBrief(state: CaseState): CaseBrief {
  const c = state.case;
  return {
    caseId: c.id,
    displayId: c.displayId,
    type: c.type,
    detectionRuleIds: c.ruleIds,
    amountBand: amountBand(c.amountMinor),
    mismatchedSystems: c.mismatched,
    flags: {
      hasRefund: (state.order?.refunds.length ?? 0) > 0,
      hasSettlementBatch: state.batch != null,
      isDuplicate: c.type === 'DUPLICATE',
      quarantinedText: c.signals.quarantined === true,
    },
  };
}
