import { formatMoney } from '@payops/shared';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';

export const holdPayment: ActionHandler<'HOLD_PAYMENT_FOR_REVIEW'> = {
  type: 'HOLD_PAYMENT_FOR_REVIEW',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    if (!s.payment || s.payment.id !== params.paymentId) return [`Payment ${params.paymentId} is not this case's payment.`];
    if (s.payment.hold) return [`Payment ${params.paymentId} is already on hold.`];
    return [];
  },

  async execute({ params }, state, { deps, write }) {
    const payment = await deps.db.transaction((tx) =>
      deps.payments.hold(tx, params.paymentId, `review for case ${state.case.displayId}`, write),
    );
    return {
      summary: `Payment ${params.paymentId} (${formatMoney(payment.amountMinor)}) is on hold and excluded from payouts`,
      result: { hold: true },
    };
  },

  postconditions({ params }, state, index) {
    const payment = state.order?.payment;
    return [
      postcondition(index, 'payment.hold', {
        subject: 'payment.hold',
        description: 'The payment is frozen for review',
        expected: 'true',
        actual: payment && payment.id === params.paymentId ? String(payment.hold) : 'payment not found',
        pass: payment?.id === params.paymentId && payment.hold,
      }),
    ];
  },
};
