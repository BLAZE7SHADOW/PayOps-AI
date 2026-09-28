import type { ActionHandler } from '../types';
import { postcondition } from '../types';

export const escalate: ActionHandler<'ESCALATE_TO_HUMAN'> = {
  type: 'ESCALATE_TO_HUMAN',

  preconditions() {
    return [];
  },

  async execute({ params }, state, { deps, write }) {
    const who = params.to === 'MANAGER' ? 'a manager' : 'the ops team';
    await deps.db.transaction((tx) =>
      deps.cases.setStatus(tx, state.case.id, 'ESCALATED', `Escalated ${state.case.displayId} to ${who}: ${params.reason}`, write),
    );
    return { summary: `Escalated ${state.case.displayId} to ${who}: ${params.reason}`, result: { to: params.to } };
  },

  postconditions(_action, state, index) {
    return [
      postcondition(index, 'case.status', {
        subject: 'case.status',
        description: 'The case is with a person',
        expected: 'ESCALATED',
        actual: state.case.status,
        pass: state.case.status === 'ESCALATED',
      }),
    ];
  },
};
