import { formatMoney } from '@payops/shared';
import { captureCreditMinor, isCaptured } from '../../reconciliation/facts';
import { liveCaptureJournals } from '../../services/ledger.service';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';

export const postLedgerEntry: ActionHandler<'POST_LEDGER_ENTRY'> = {
  type: 'POST_LEDGER_ENTRY',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    if (!s.payment || s.payment.id !== params.paymentId) return [`Payment ${params.paymentId} is not this case's payment.`];
    const failures: string[] = [];
    const gw = s.gateway.find((g) => g.id === s.payment?.gwPaymentId);
    if (!gw || !isCaptured(gw)) {
      failures.push(`The gateway shows ${s.payment.gwPaymentId} as ${gw?.status ?? 'missing'}; only captured payments are posted.`);
    } else if (params.amountMinor !== gw.amountMinor) {
      failures.push(`Amount ${formatMoney(params.amountMinor)} does not match the gateway capture of ${formatMoney(gw.amountMinor)}.`);
    }
    const credit = captureCreditMinor(s);
    if (credit > 0) failures.push(`A capture credit of ${formatMoney(credit)} is already posted for ${params.paymentId}.`);
    return failures;
  },

  async execute({ params }, state, { deps, write }) {
    const payment = state.order?.payment;
    if (!payment) throw new Error(NO_ORDER);
    const journalId = await deps.db.transaction((tx) =>
      deps.ledger.postCapture(tx, { paymentId: params.paymentId, merchantId: payment.merchantId, amountMinor: params.amountMinor, source: 'EXECUTOR' }, write),
    );
    return {
      summary: `Posted capture journal ${journalId} for ${formatMoney(params.amountMinor)}: debit settlement clearing, credit merchant payable`,
      result: { journalId },
    };
  },

  postconditions({ params }, state, index) {
    const entries = (state.order?.ledger ?? []).filter((e) => e.paymentId === params.paymentId);
    const journals = liveCaptureJournals(entries);
    const credit = captureCreditMinor({ ledger: entries });
    return [
      postcondition(index, 'ledger.captureCredit', {
        subject: 'ledger.captureCredit',
        description: 'Exactly one capture credit equal to the captured amount',
        expected: `1 journal, ${formatMoney(params.amountMinor)}`,
        actual: `${journals.length} journal${journals.length === 1 ? '' : 's'}, ${formatMoney(credit)}`,
        pass: journals.length === 1 && credit === params.amountMinor,
      }),
    ];
  },
};
