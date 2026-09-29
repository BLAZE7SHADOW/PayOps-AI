import { formatMoney } from '@payops/shared';
import { captureCreditMinor, isCaptured } from '../../reconciliation/facts';
import { summarizeJournals } from '../../services/ledger.service';
import type { ActionHandler } from '../types';
import { postcondition } from '../types';
import { NO_ORDER } from '../facts';

export const reverseLedgerEntry: ActionHandler<'REVERSE_LEDGER_ENTRY'> = {
  type: 'REVERSE_LEDGER_ENTRY',

  preconditions({ params }, state) {
    const s = state.order;
    if (!s) return [NO_ORDER];
    const journal = summarizeJournals(s.ledger).find((j) => j.journalId === params.journalId);
    if (!journal) return [`Journal ${params.journalId} is not on this case's ledger.`];
    if (journal.kind === 'REVERSAL') return [`Journal ${params.journalId} is itself a reversal.`];
    if (journal.reversedBy) return [`Journal ${params.journalId} was already reversed by ${journal.reversedBy}.`];
    return [];
  },

  async execute({ params }, state, { deps, write }) {
    const journal = summarizeJournals(state.order?.ledger ?? []).find((j) => j.journalId === params.journalId);
    const reversalId = await deps.db.transaction((tx) => deps.ledger.reverseJournal(tx, params.journalId, 'EXECUTOR', write));
    return {
      summary: `Reversed journal ${params.journalId}${journal ? ` (${formatMoney(journal.amountMinor)})` : ''} with ${reversalId}; the original stays on the ledger`,
      result: { reversalId },
    };
  },

  postconditions({ params }, state, index) {
    const s = state.order;
    const journal = summarizeJournals(s?.ledger ?? []).find((j) => j.journalId === params.journalId);
    // An undo removes the capture credit on purpose, so nothing should remain (D070).
    const expected = params.undoOf ? 0 : s && isCaptured(s.primaryGw) ? (s.primaryGw?.amountMinor ?? 0) : 0;
    const actual = s ? captureCreditMinor(s) : 0;
    return [
      postcondition(index, 'ledger.reversed', {
        subject: `journal ${params.journalId}`,
        description: 'The journal has an equal and opposite reversal',
        expected: 'reversed',
        actual: journal?.reversedBy ? `reversed by ${journal.reversedBy}` : 'not reversed',
        pass: Boolean(journal?.reversedBy),
      }),
      postcondition(index, 'ledger.netCapture', {
        subject: 'ledger.captureCredit',
        description: params.undoOf ? 'No capture credit remains after the undo' : 'Net capture credit matches what the gateway captured',
        expected: formatMoney(expected),
        actual: formatMoney(actual),
        pass: actual === expected,
      }),
    ];
  },
};
