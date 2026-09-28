import { formatMoney } from '@payops/shared';
import { coveringDispute } from '../../reconciliation/settlement';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';

export const raiseSettlementDispute: ActionHandler<'RAISE_SETTLEMENT_DISPUTE'> = {
  type: 'RAISE_SETTLEMENT_DISPUTE',

  preconditions({ params }, state) {
    const b = state.batch;
    if (!b || b.data.settlement.id !== params.batchId) return [`Batch ${params.batchId} is not this case's settlement batch.`];
    const failures: string[] = [];
    const diff = b.check.diffMinor;
    if (diff === 0 || b.data.settlement.status !== 'MISMATCH') {
      failures.push(`Batch ${params.batchId} is ${b.data.settlement.status}; there is no difference to dispute.`);
    } else if (params.amountMinor !== Math.abs(diff)) {
      failures.push(`Amount ${formatMoney(params.amountMinor)} does not match the batch difference of ${formatMoney(Math.abs(diff))}.`);
    }
    const open = b.data.disputes.find((d) => d.status === 'OPEN');
    if (open) failures.push(`Batch ${params.batchId} already has an open dispute (${open.id}).`);
    if (params.gwPaymentId && !b.data.lines.some((l) => l.gwPaymentId === params.gwPaymentId)) {
      failures.push(`Payment ${params.gwPaymentId} is not in batch ${params.batchId}.`);
    }
    return failures;
  },

  async execute({ params }, state, { deps, write, resolutionId }) {
    const check = state.batch?.check;
    const lines = check?.offendingLines.length ?? 0;
    const direction = (check?.diffMinor ?? 0) < 0 ? 'short' : 'over';
    const reason = `Batch net ${direction} by ${formatMoney(params.amountMinor)} across ${lines} line${lines === 1 ? '' : 's'} charged off contract`;
    const dispute = await deps.db.transaction((tx) =>
      deps.disputes.raiseSettlement(
        tx,
        { batchId: params.batchId, gwPaymentId: params.gwPaymentId ?? null, amountMinor: params.amountMinor, reason, resolutionId },
        write,
      ),
    );
    return {
      summary: `Raised settlement dispute ${dispute.id} for ${formatMoney(params.amountMinor)} on batch ${params.batchId}`,
      result: { disputeId: dispute.id },
    };
  },

  postconditions({ params }, state, index) {
    const b = state.batch;
    const covering = b ? coveringDispute(b.data.disputes, b.check.diffMinor) : null;
    const open = b?.data.disputes.find((d) => d.status === 'OPEN');
    return [
      postcondition(index, 'dispute.open', {
        subject: `batch ${params.batchId}`,
        description: 'An open dispute covers the settlement difference',
        expected: `OPEN dispute for ${formatMoney(Math.abs(b?.check.diffMinor ?? params.amountMinor))}`,
        actual: open ? `${open.status} dispute for ${formatMoney(open.amountMinor)}` : 'no open dispute',
        pass: covering !== null,
      }),
    ];
  },
};
