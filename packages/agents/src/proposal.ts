import { postconditionsOf, type AttemptHistory, type CaseState } from '@payops/core';
import type { Diagnosis, ResolutionProposal } from '@payops/shared';
import { templateActions } from './templates';

/** Builds the concrete proposal from a diagnosis (fast or full path alike). */
export function buildProposal(diagnosis: Diagnosis, state: CaseState, history: AttemptHistory[] = []): ResolutionProposal {
  const actions = templateActions(diagnosis.rootCause, state, history);
  const expectedPostconditions = actions.flatMap((a, i) => postconditionsOf(a, state, i).map((c) => c.description));
  return { actions, rationale: diagnosis.narrative, expectedPostconditions };
}
