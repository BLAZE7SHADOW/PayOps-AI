import type { CaseDetail } from '@payops/shared';

export type VerdictTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface CaseVerdict {
  tone: VerdictTone;
  /** One sentence an operator can act on without reading anything else. */
  text: string;
}

/**
 * The one-line answer at the top of a case: is it fixed, and does anyone need to do something?
 * Derived only from the case and its latest resolution, so it never disagrees with the story below.
 */
export function caseVerdict(c: CaseDetail): CaseVerdict {
  const latest = [...(c.resolutionView?.resolutions ?? [])].sort((a, b) => b.attempt - a.attempt)[0];
  const decidedBy = latest?.approval?.decidedBy?.name ?? null;
  switch (c.status) {
    case 'RESOLVED':
      if (c.resolution?.by === 'USER') return { tone: 'ok', text: 'Fixed by a person and verified. Nothing more is needed.' };
      if (decidedBy) return { tone: 'ok', text: `Fixed after ${decidedBy} approved it, and verified. Nothing more is needed from you.` };
      return { tone: 'ok', text: 'Fixed automatically and verified. Nothing needed from you.' };
    case 'AWAITING_APPROVAL': {
      const tier = latest?.approval?.tier;
      const who = tier === 'MANAGER' ? 'a manager' : tier === 'OPS' ? 'an operator' : 'an approver';
      return { tone: 'warn', text: `Waiting for ${who} to approve the proposed fix. Nothing has changed yet.` };
    }
    case 'ESCALATED':
      return { tone: 'bad', text: 'The agent could not fix this safely. A person needs to take over.' };
    case 'REJECTED':
      return { tone: 'neutral', text: 'Closed. The proposed fix was rejected and nothing was changed.' };
    case 'EXECUTING':
      return { tone: 'neutral', text: 'The approved fix is running now. It will be verified when it finishes.' };
    case 'INVESTIGATING':
      return { tone: 'neutral', text: 'An investigation is running. Nothing needed from you yet.' };
    default:
      return { tone: 'warn', text: 'Open and not yet investigated. Start an investigation or resolve it manually.' };
  }
}
