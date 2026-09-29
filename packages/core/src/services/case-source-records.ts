import { formatMoney, type CaseSourceRecord, type CaseSourceRecords } from '@payops/shared';
import type { CaseState } from '../actions/types';

/** Read-only operator view of fresh domain/gateway records. No model output is used. */
export function projectCaseSourceRecords(state: CaseState): CaseSourceRecords {
  const records: CaseSourceRecord[] = [];
  const add = (record: CaseSourceRecord) => records.push(record);
  const order = state.order;
  if (order) {
    for (const payment of order.gateway) add({
      system: 'GATEWAY', kind: 'Gateway payment', id: payment.id, status: payment.status,
      amountMinor: payment.amountMinor, at: (payment.capturedAt ?? payment.createdAt).toISOString(),
      details: [
        { label: 'Order', value: payment.orderRef },
        { label: 'Refunded', value: formatMoney(payment.refundedMinor) },
      ],
    });
    add({
      system: 'ORDER', kind: 'Order', id: order.order.id, status: order.order.status,
      amountMinor: order.order.amountMinor, at: order.order.updatedAt.toISOString(),
      details: [
        { label: 'Linked payment', value: order.order.paymentId ?? 'None' },
        { label: 'Version', value: String(order.order.version) },
      ],
    });
    if (order.payment) add({
      system: 'ORDER', kind: 'Internal payment', id: order.payment.id, status: order.payment.status,
      amountMinor: order.payment.amountMinor, at: order.payment.updatedAt.toISOString(),
      details: [
        { label: 'Gateway payment', value: order.payment.gwPaymentId },
        { label: 'Held', value: order.payment.hold ? 'Yes' : 'No' },
      ],
    });
    for (const delivery of order.webhooks) add({
      system: 'WEBHOOK', kind: 'Webhook delivery', id: delivery.id, status: delivery.finalStatus,
      amountMinor: null, at: delivery.createdAt.toISOString(),
      details: [
        { label: 'Event', value: delivery.event },
        { label: 'Gateway payment', value: delivery.gwPaymentId },
        ...delivery.attempts.map((attempt, index) => ({ label: `Attempt ${index + 1}`, value: `HTTP ${attempt.httpStatus ?? 'no response'} · ${attempt.at}` })),
      ],
    });
    for (const entry of order.ledger) add({
      system: 'LEDGER', kind: 'Ledger entry', id: entry.id, status: `${entry.direction} ${entry.account}`,
      amountMinor: entry.amountMinor, at: entry.postedAt.toISOString(),
      details: [
        { label: 'Journal', value: entry.journalId },
        { label: 'Payment', value: entry.paymentId ?? 'None' },
        { label: 'Source', value: entry.source },
      ],
    });
    for (const refund of order.refunds) add({
      system: 'REFUND', kind: 'Internal refund', id: refund.id, status: refund.status,
      amountMinor: refund.amountMinor, at: refund.updatedAt.toISOString(),
      details: [
        { label: 'Gateway payment', value: refund.gwPaymentId },
        { label: 'Gateway refund', value: refund.gwRefundId ?? 'None' },
      ],
    });
    for (const refund of order.gwRefunds) add({
      system: 'REFUND', kind: 'Gateway refund', id: refund.id, status: refund.status,
      amountMinor: refund.amountMinor, at: (refund.processedAt ?? refund.createdAt).toISOString(),
      details: [{ label: 'Gateway payment', value: refund.gwPaymentId }],
    });
    for (const line of order.settlementLines) add({
      system: 'SETTLEMENT', kind: 'Gateway settlement line', id: line.id, status: 'SETTLED',
      amountMinor: line.netMinor, at: line.settledOn.toISOString(),
      details: [
        { label: 'Batch', value: line.batchId }, { label: 'Gateway payment', value: line.gwPaymentId },
        { label: 'Gross', value: formatMoney(line.grossMinor) },
        { label: 'Fee', value: formatMoney(line.feeMinor) }, { label: 'Tax', value: formatMoney(line.taxMinor) },
      ],
    });
  }
  if (state.batch) {
    const { data, check } = state.batch;
    add({
      system: 'SETTLEMENT', kind: 'Settlement batch', id: data.settlement.id, status: data.settlement.status,
      amountMinor: data.settlement.reportedNetMinor, at: data.settlement.settledOn.toISOString(),
      details: [
        { label: 'Expected from contract', value: formatMoney(check.expectedNetMinor) },
        { label: 'Reported by gateway', value: formatMoney(check.reportedNetMinor) },
        { label: 'Difference', value: formatMoney(check.diffMinor) },
      ],
    });
    for (const line of data.lines) {
      const expected = check.offendingLines.find((item) => item.line.id === line.id);
      add({
        system: 'SETTLEMENT', kind: 'Gateway settlement line', id: line.id, status: expected ? 'AMOUNT DIFFERS' : 'MATCHED',
        amountMinor: line.netMinor, at: line.settledOn.toISOString(),
        details: [
          { label: 'Gateway payment', value: line.gwPaymentId },
          { label: 'Gross', value: formatMoney(line.grossMinor) },
          { label: 'Fee', value: formatMoney(line.feeMinor) },
          { label: 'Tax', value: formatMoney(line.taxMinor) },
          ...(expected ? [{ label: 'Expected net', value: formatMoney(expected.expected.netMinor) }] : []),
        ],
      });
    }
    for (const dispute of data.disputes) add({
      system: 'DISPUTE', kind: 'Settlement dispute', id: dispute.id, status: dispute.status,
      amountMinor: dispute.amountMinor, at: dispute.updatedAt.toISOString(),
      details: [{ label: 'Batch', value: dispute.batchId }, { label: 'Reason', value: dispute.reason }],
    });
  }
  return { caseId: state.case.id, readAt: state.now.toISOString(), records };
}
