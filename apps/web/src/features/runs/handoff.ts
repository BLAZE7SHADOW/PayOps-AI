import type { AgentRunItem } from '@payops/shared';

export interface Handoff {
  title: string;
  /** The specific reason, taken from what the run recorded. */
  reason: string;
  /** What a person can do now. */
  steps: string[];
}

type RunInput = Pick<AgentRunItem, 'status' | 'diagnosis' | 'policy' | 'validation' | 'error'>;

const MANUAL = 'Resolve manually from the case page, using the closed list of actions.';
const RECORDS = 'Check the source records to see the current state.';

/**
 * Plain-language message for when an agent run stops without resolving the case (P1 task 4).
 * Everything in `reason` comes from what the run recorded; nothing is guessed. Returns null when
 * the run is still working or already resolved the case.
 */
export function describeHandoff(run: RunInput): Handoff | null {
  const { status } = run;
  if (status !== 'ESCALATED' && status !== 'REJECTED' && status !== 'FAILED') return null;

  if (status === 'REJECTED') {
    return {
      title: 'A person rejected the proposed fix.',
      reason: 'Nothing was changed. The case stays open.',
      steps: ['Start a new investigation, or resolve the case manually.'],
    };
  }

  if (run.policy?.tier === 'BLOCKED') {
    const blocking = run.policy.reasons.filter((r) => r.tier === 'BLOCKED').map((r) => r.reason);
    return {
      title: 'Policy blocked the proposed fix.',
      reason: blocking.join(' ') || 'A policy rule blocked the proposal.',
      steps: ['Nobody can approve a blocked proposal. Change the facts it relied on, or handle the case by hand.', RECORDS],
    };
  }

  const verdict = run.validation?.verdict;
  if (verdict === 'FAIL' || verdict === 'PARTIAL') {
    const failed = run.validation?.checks.find((c) => !c.pass);
    return {
      title: 'The fix ran but the check did not pass.',
      reason: failed ? `${failed.description}: expected ${failed.expected}, found ${failed.actual}.` : 'The independent check did not confirm the fix.',
      steps: [RECORDS, 'Decide whether another attempt or a manual fix is safer.', MANUAL],
    };
  }

  if (run.diagnosis?.rootCause === 'UNKNOWN') {
    return {
      title: 'The agent could not confirm the cause.',
      reason: run.diagnosis.narrative,
      steps: [RECORDS, 'If a listed cause looks right, pick it and check the evidence for it.', MANUAL],
    };
  }

  if (run.error) {
    return { title: 'The agent stopped before proposing a fix.', reason: run.error, steps: [RECORDS, MANUAL] };
  }

  return {
    title: status === 'FAILED' ? 'The investigation did not finish.' : 'The agent handed this case to a person.',
    reason: 'The run recorded no further detail.',
    steps: [RECORDS, MANUAL],
  };
}
