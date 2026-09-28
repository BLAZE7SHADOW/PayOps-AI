import { CAPTURE_KNOWN_STATUSES } from '../../reconciliation/facts';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';

export const markOrderPaid: ActionHandler<'MARK_ORDER_PAID'> = {
  type: 'MARK_ORDER_PAID',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    const failures: string[] = [];
    if (params.orderId !== s.order.id) failures.push(`Order ${params.orderId} is not this case's order.`);
    if (!s.payment || s.payment.id !== params.paymentId) {
      failures.push(`Payment ${params.paymentId} is not the internal payment of order ${s.order.id}.`);
    } else {
      const gw = s.gateway.find((g) => g.id === s.payment?.gwPaymentId);
      if (gw?.status !== 'CAPTURED') {
        failures.push(`The gateway shows ${s.payment.gwPaymentId} as ${gw?.status ?? 'missing'}, not CAPTURED.`);
      }
    }
    if (s.order.status === 'PAID' || s.order.status === 'FULFILLED' || s.order.status === 'CANCELLED') {
      failures.push(`Order ${s.order.id} is already ${s.order.status}.`);
    }
    return failures;
  },

  async execute({ params }, state, { deps, write }) {
    const s = state.order;
    if (!s || !s.payment) throw new Error(NO_ORDER);
    const payment = s.payment;
    const from = s.order.status;
    const paymentUpdated = await deps.db.transaction(async (tx) => {
      await deps.orders.transition(
        tx,
        params.orderId,
        'PAID',
        { by: 'executor', reason: `Gateway capture ${payment.gwPaymentId} verified`, expectedVersion: s.order.version, paymentId: params.paymentId },
        write,
      );
      if (CAPTURE_KNOWN_STATUSES.has(payment.status)) return false;
      await deps.payments.setStatus(tx, params.paymentId, 'CAPTURED', `gateway capture ${payment.gwPaymentId} verified`, write);
      return true;
    });
    return {
      summary: `Order ${params.orderId} moved ${from} to PAID and linked to ${params.paymentId}${paymentUpdated ? '; internal payment marked CAPTURED' : ''}`,
      result: { from, to: 'PAID', paymentUpdated },
    };
  },

  postconditions({ params }, state, index) {
    const order = state.order?.order;
    return [
      postcondition(index, 'order.status', {
        subject: 'order.status',
        description: 'The order is paid',
        expected: 'PAID',
        actual: order?.status ?? 'order not found',
        pass: order?.status === 'PAID' || order?.status === 'FULFILLED',
      }),
      postcondition(index, 'order.paymentId', {
        subject: 'order.paymentId',
        description: 'The order points at the captured payment',
        expected: params.paymentId,
        actual: order?.paymentId ?? 'not set',
        pass: order?.paymentId === params.paymentId,
      }),
    ];
  },
};
