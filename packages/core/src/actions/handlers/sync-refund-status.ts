import { formatMoney } from '@payops/shared';
import { AppError } from '../../errors';
import { REFUND_STATUS_FROM_GATEWAY } from '../../services/refund.service';
import { summarizeJournals } from '../../services/ledger.service';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';

export const syncRefundStatus: ActionHandler<'SYNC_REFUND_STATUS'> = {
  type: 'SYNC_REFUND_STATUS',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    const refund = s.refunds.find((r) => r.id === params.refundId);
    if (!refund) return [`Refund ${params.refundId} is not on this case.`];
    if (refund.status === 'PROCESSED') return [`Refund ${refund.id} is already PROCESSED.`];
    if (!refund.gwRefundId) return [`Refund ${refund.id} was never sent to the gateway, so there is no status to copy.`];
    const gw = s.gwRefunds.find((r) => r.id === refund.gwRefundId);
    if (!gw) return [`The gateway has no refund ${refund.gwRefundId}.`];
    if (gw.status === 'PENDING') return [`The gateway still shows refund ${gw.id} as PENDING.`];
    if (REFUND_STATUS_FROM_GATEWAY[gw.status] === refund.status) return [`Refund ${refund.id} already matches the gateway (${gw.status}).`];
    return [];
  },

  async execute({ params }, state, { deps, write }) {
    const refund = state.order?.refunds.find((r) => r.id === params.refundId);
    if (!refund?.gwRefundId) throw new Error(`Refund ${params.refundId} has no gateway refund`);
    const [gwRefunds, [gwPayment]] = await Promise.all([
      deps.gateway.listRefunds([refund.gwPaymentId]),
      deps.gateway.getPayments([refund.gwPaymentId]),
    ]);
    const gwRefund = gwRefunds.find((r) => r.id === refund.gwRefundId);
    if (!gwRefund || !gwPayment) throw new AppError('NOT_FOUND', `Gateway refund ${refund.gwRefundId} not found`);
    const from = refund.status;
    await deps.db.transaction(async (tx) => {
      const row = await deps.refunds.lock(tx, refund.id);
      if (gwRefund.status === 'FAILED') await deps.refunds.markFailed(tx, row, `gateway refund ${gwRefund.id} failed`, write);
      else await deps.refunds.applyGatewayStatus(tx, row, gwRefund, gwPayment, 'EXECUTOR', write);
    });
    const to = REFUND_STATUS_FROM_GATEWAY[gwRefund.status];
    return {
      summary: `Refund ${refund.id} moved ${from} to ${to} to match gateway refund ${gwRefund.id}${to === 'PROCESSED' ? `; refund journal of ${formatMoney(refund.amountMinor)} posted` : ''}`,
      result: { from, to, gwRefundId: gwRefund.id },
    };
  },

  postconditions({ params }, state, index) {
    const s = state.order;
    const refund = s?.refunds.find((r) => r.id === params.refundId);
    const gw = refund?.gwRefundId ? s?.gwRefunds.find((r) => r.id === refund.gwRefundId) : undefined;
    const expected = gw ? REFUND_STATUS_FROM_GATEWAY[gw.status] : 'gateway status';
    const checks = [
      postcondition(index, 'refund.status', {
        subject: 'refund.status',
        description: 'Our refund status equals the gateway refund status',
        expected,
        actual: refund?.status ?? 'refund not found',
        pass: refund !== undefined && gw !== undefined && refund.status === expected,
      }),
    ];
    if (gw?.status === 'PROCESSED') {
      const posted = summarizeJournals(s?.ledger ?? []).some((j) => j.kind === 'REFUND' && j.reversedBy === null && j.legs[0]?.refundId === params.refundId);
      checks.push(
        postcondition(index, 'ledger.refundJournal', {
          subject: 'ledger.refund',
          description: 'The processed refund is posted to the ledger',
          expected: 'refund journal posted',
          actual: posted ? 'refund journal posted' : 'no refund journal',
          pass: posted,
        }),
      );
    }
    return checks;
  },
};
