import { SYSTEMS, type SystemKey } from '@payops/shared';
import { SYSTEM_LABEL, SYSTEM_LETTER } from '../lib/status';
import { mismatchSummary } from './StateMatrix';
import { cx } from './cx';

/** Five small squares G O L W S; the ones that disagree are bad-tinted and bold. */
export function MiniMatrix({ mismatched }: { mismatched: SystemKey[] }) {
  const label = mismatched.length ? `Disagree: ${mismatchSummary(mismatched)}` : 'All systems agree';
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex gap-0.5 align-middle">
      {SYSTEMS.map((s) => {
        const bad = mismatched.includes(s);
        return (
          <span
            key={s}
            data-system={s}
            data-mismatch={bad || undefined}
            aria-hidden="true"
            title={SYSTEM_LABEL[s]}
            className={cx(
              'grid size-4 place-items-center border font-mono text-[10px] leading-none',
              bad ? 'border-bad bg-bad-weak font-semibold text-bad' : 'border-rule bg-surface-sunk text-ink-2',
            )}
          >
            {SYSTEM_LETTER[s]}
          </span>
        );
      })}
    </span>
  );
}
