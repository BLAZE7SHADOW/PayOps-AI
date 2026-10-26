import type { CaseDetail } from '@payops/shared';
import { caseProgress, type StageState } from './case-progress';

const STATE_WORD: Record<StageState, string> = { done: 'Done', current: 'Now', stopped: 'Stopped', upcoming: 'Next' };
const STATE_TEXT: Record<StageState, string> = { done: 'text-ink-2', current: 'text-ink', stopped: 'text-bad', upcoming: 'text-ink-2' };
const STATE_RULE: Record<StageState, string> = { done: 'border-ink-2', current: 'border-accent', stopped: 'border-bad', upcoming: 'border-rule' };

/** The path of the case in five stages: what is done, what is happening now, and what comes next. */
export function CaseProgress({ c }: { c: CaseDetail }) {
  const stages = caseProgress(c);
  return (
    <ol aria-label="Case progress" data-testid="case-progress" className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-5">
      {stages.map((s) => (
        <li key={s.key} aria-current={s.state === 'current' || s.state === 'stopped' ? 'step' : undefined} className={`border-t-2 pt-2 ${STATE_RULE[s.state]}`}>
          <p className={`text-12 font-semibold tracking-wide uppercase ${STATE_TEXT[s.state]}`}>{STATE_WORD[s.state]}</p>
          <p className={`mt-1 text-14 font-medium ${s.state === 'upcoming' ? 'text-ink-2' : 'text-ink'}`}>{s.label}</p>
          {s.note ? <p className="mt-0.5 text-13 text-ink-2">{s.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
