import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';
import { isCaptured } from '../../reconciliation/facts';

const httpLabel = (status: number | null | undefined) => (status == null ? 'no answer' : `HTTP ${status}`);

export const replayWebhook: ActionHandler<'REPLAY_WEBHOOK_EVENT'> = {
  type: 'REPLAY_WEBHOOK_EVENT',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    const delivery = s.webhooks.find((w) => w.id === params.eventId);
    if (!delivery) return [`Event ${params.eventId} does not belong to this case's payments.`];
    if (delivery.finalStatus === 'DELIVERED') return [`Event ${params.eventId} (${delivery.event}) was already delivered.`];
    const gw = s.gateway.find((g) => g.id === delivery.gwPaymentId);
    if (delivery.event === 'payment.captured' && !isCaptured(gw ?? null)) {
      return [`The gateway shows ${delivery.gwPaymentId} as ${gw?.status ?? 'missing'}, so replaying payment.captured would change nothing.`];
    }
    return [];
  },

  async execute({ params }, state, { deps }) {
    const delivery = state.order?.webhooks.find((w) => w.id === params.eventId);
    const result = await deps.gateway.replayWebhook(params.eventId);
    const ok = result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
    const event = delivery?.event ?? 'event';
    return {
      summary: `Gateway re-delivered ${event} (${params.eventId}): consumer answered ${httpLabel(result.httpStatus)}${ok ? '' : ', so nothing changed'}`,
      result: { httpStatus: result.httpStatus, attemptAt: result.attemptAt },
    };
  },

  postconditions({ params }, state, index) {
    const s = state.order;
    const delivery = s?.webhooks.find((w) => w.id === params.eventId);
    const last = delivery?.attempts[delivery.attempts.length - 1];
    const checks = [
      postcondition(index, 'webhook.delivery', {
        subject: `webhook ${params.eventId}`,
        description: 'The replayed event was accepted by our consumer',
        expected: 'HTTP 2xx, DELIVERED',
        actual: delivery ? `${httpLabel(last?.httpStatus)}, ${delivery.finalStatus}` : 'event not found',
        pass: delivery?.finalStatus === 'DELIVERED',
      }),
    ];
    if (s && delivery?.event === 'payment.captured') {
      const gw = s.gateway.find((g) => g.id === delivery.gwPaymentId);
      const internal = s.payment?.gwPaymentId === delivery.gwPaymentId ? s.payment : null;
      checks.push(
        postcondition(index, 'payment.status', {
          subject: 'payment.status',
          description: 'Our payment record matches the gateway',
          expected: gw?.status ?? 'unknown',
          actual: internal?.status ?? 'no internal payment',
          pass: gw !== undefined && internal !== null && internal.status === gw.status,
        }),
      );
    }
    if (s && delivery && delivery.event.startsWith('refund.') && delivery.gwRefundId) {
      const gwRefund = s.gwRefunds.find((r) => r.id === delivery.gwRefundId);
      const internal = s.refunds.find((r) => r.gwRefundId === delivery.gwRefundId);
      checks.push(
        postcondition(index, 'refund.status', {
          subject: 'refund.status',
          description: 'Our refund record matches the gateway',
          expected: gwRefund?.status ?? 'unknown',
          actual: internal?.status ?? 'no internal refund',
          pass: gwRefund !== undefined && internal?.status === gwRefund.status,
        }),
      );
    }
    return checks;
  },
};
