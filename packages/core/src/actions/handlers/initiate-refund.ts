import { formatMoney } from '@payops/shared';
import { AppError } from '../../errors';
import { REFUND_STATUS_FROM_GATEWAY } from '../../services/refund.service';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER, refundableMinor } from '../facts';

export const initiateRefund: ActionHandler<'INITIATE_REFUND'> = {
  type: 'INITIATE_REFUND',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    const gw = s.gateway.find((g) => g.id === params.gwPaymentId);
    if (!gw) return [`Gateway payment ${params.gwPaymentId} does not belong to this case's order.`];
    if (gw.status !== 'CAPTURED' && gw.status !== 'PARTIALLY_REFUNDED') {
      return [`Gateway payment ${gw.id} is ${gw.status}; only captured payments can be refunded.`];
    }
    const refundable = refundableMinor(s, gw.id);
    if (params.amountMinor > refundable) {
      return [`${formatMoney(params.amountMinor)} is more than the refundable balance of ${formatMoney(refundable)} on ${gw.id}.`];
    }
    return [];
  },

  /**
   * Three short steps, never nested: record our refund (REQUESTED), call the gateway (which
   * delivers refund.processed to our consumer), then make sure our record is linked and mirrors
   * the gateway even if the webhook did not arrive.
   */
  async execute({ params }, _state, { deps, write }) {
    const requested = await deps.db.transaction((tx) =>
      deps.refunds.createRequested(tx, { gwPaymentId: params.gwPaymentId, amountMinor: params.amountMinor, reason: params.reason }, write),
    );
    let gwRefund;
    try {
      gwRefund = await deps.gateway.createRefund({ gwPaymentId: params.gwPaymentId, amountMinor: params.amountMinor });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gateway error';
      await deps.db.transaction(async (tx) => deps.refunds.markFailed(tx, await deps.refunds.lock(tx, requested.id), message, write));
      throw err instanceof AppError ? err : new AppError('CONFLICT', message);
    }
    const [gwPayment] = await deps.gateway.getPayments([params.gwPaymentId]);
    if (!gwPayment) throw new AppError('NOT_FOUND', `Gateway payment ${params.gwPaymentId} not found`);
    const final = await deps.db.transaction(async (tx) => {
      const row = await deps.refunds.lock(tx, requested.id);
      if (row.gwRefundId === gwRefund.id && row.status === REFUND_STATUS_FROM_GATEWAY[gwRefund.status]) return row;
      if (gwRefund.status === 'FAILED') {
        await deps.refunds.markFailed(tx, row, `gateway refund ${gwRefund.id} failed`, write);
        return { ...row, status: 'FAILED' as const };
      }
      return deps.refunds.applyGatewayStatus(tx, row, gwRefund, gwPayment, 'EXECUTOR', write);
    });
    const posted = final.status === 'PROCESSED' ? ' and posted to the ledger' : '';
    return {
      summary: `Gateway refunded ${formatMoney(params.amountMinor)} on ${params.gwPaymentId} (${gwRefund.id}, ${gwRefund.status}); refund ${final.id} is ${final.status}${posted}`,
      result: { refundId: final.id, gwRefundId: gwRefund.id, gatewayStatus: gwRefund.status, status: final.status },
    };
  },

  postconditions({ params }, state, index) {
    const s = state.order;
    const internal = (s?.refunds ?? [])
      .filter((r) => r.gwPaymentId === params.gwPaymentId && r.amountMinor === params.amountMinor && r.reason === params.reason)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
    const gwRefund = internal?.gwRefundId ? s?.gwRefunds.find((r) => r.id === internal.gwRefundId) : undefined;
    const gw = s?.gateway.find((g) => g.id === params.gwPaymentId);
    return [
      postcondition(index, 'refund.gateway', {
        subject: 'gateway refund',
        description: 'The gateway has the refund, pending or processed, for the amount asked',
        expected: `PENDING or PROCESSED, ${formatMoney(params.amountMinor)}`,
        actual: gwRefund ? `${gwRefund.status}, ${formatMoney(gwRefund.amountMinor)}` : 'no gateway refund',
        pass: gwRefund !== undefined && gwRefund.status !== 'FAILED' && gwRefund.amountMinor === params.amountMinor,
      }),
      postcondition(index, 'refund.internal', {
        subject: 'refund.status',
        description: 'Our refund record mirrors the gateway refund',
        expected: gwRefund ? REFUND_STATUS_FROM_GATEWAY[gwRefund.status] : 'a linked refund',
        actual: internal ? `${internal.status}${internal.gwRefundId ? '' : ', not linked'}` : 'no internal refund',
        pass: internal !== undefined && gwRefund !== undefined && internal.status === REFUND_STATUS_FROM_GATEWAY[gwRefund.status],
      }),
      postcondition(index, 'refund.balance', {
        subject: 'gateway refunded total',
        description: 'Refunds never exceed the captured amount',
        expected: gw ? `at most ${formatMoney(gw.amountMinor)}` : 'captured payment',
        actual: gw ? formatMoney(gw.refundedMinor) : 'payment not found',
        pass: gw !== undefined && gw.refundedMinor <= gw.amountMinor,
      }),
    ];
  },
};
