import type { OverviewMetrics, ValidationVerdict } from '@payops/shared';
import { Skeleton } from '../../ui/Skeleton';

const VERDICTS: Array<{ verdict: ValidationVerdict; meaning: string; bar: string }> = [
  { verdict: 'PASS', meaning: 'Every check matched', bar: 'bg-ok' },
  { verdict: 'PARTIAL', meaning: 'Some checks failed', bar: 'bg-warn' },
  { verdict: 'FAIL', meaning: 'Outcome not reached', bar: 'bg-bad' },
];

/**
 * Validator verdicts as three labelled rows with proportional bars. The count and the verdict
 * word carry the meaning; the bar color is redundant, so nothing depends on color alone.
 */
export function ValidatorOutcomes({ data }: { data: OverviewMetrics['validatorOutcomes7d'] | undefined }) {
  const total = data ? VERDICTS.reduce((s, v) => s + data[v.verdict], 0) : 0;
  return (
    <div className="border border-rule bg-surface px-4 py-3">
      {!data ? (
        <ul aria-hidden="true" className="flex flex-col gap-3">
          {VERDICTS.map((v) => (
            <li key={v.verdict} className="flex h-8 items-center">
              <Skeleton width="100%" height={10} />
            </li>
          ))}
        </ul>
      ) : total === 0 ? (
        <p className="py-2 text-13 text-ink-2">No verifications in the last 7 days.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {VERDICTS.map(({ verdict, meaning, bar }) => {
            const n = data[verdict];
            return (
              <li key={verdict}>
                <div className="flex items-baseline justify-between text-12">
                  <span className="font-mono text-ink">{verdict}</span>
                  <span className="tabular font-mono text-ink">{n}</span>
                </div>
                <div className="mt-1 h-2 bg-surface-sunk" aria-hidden="true">
                  <div className={`h-full ${bar}`} style={{ width: `${(n / total) * 100}%` }} />
                </div>
                <p className="mt-0.5 text-12 text-ink-2">{meaning}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
