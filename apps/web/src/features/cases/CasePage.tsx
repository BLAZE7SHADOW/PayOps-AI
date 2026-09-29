import { useParams } from 'react-router';
import { DETECTION_RULE_LABEL, type CaseDetail } from '@payops/shared';
import { useCaseRoom } from '../../lib/socket';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Investigation, InvestigationSkeleton } from '../investigation/Investigation';
import { ErrorState } from '../../ui/ErrorState';
import { Section } from '../../ui/Section';
import { Skeleton } from '../../ui/Skeleton';
import { StateMatrix, StateMatrixSkeleton, mismatchSummary } from '../../ui/StateMatrix';
import { Timeline, TimelineSkeleton } from '../../ui/Timeline';
import { useCase } from './api';
import { CaseDetails, CaseDetailsSkeleton } from './CaseDetails';
import { CaseHeader, CaseHeaderSkeleton } from './CaseHeader';
import { CaseActions } from './CaseActions';
import { ResolutionSection } from '../resolution/ResolutionSection';

export function CasePage() {
  const { caseId = '' } = useParams();
  const q = useCase(caseId);
  const c = q.data;
  // Per-case events (resolution.updated, execution steps) arrive only while we are in the room.
  useCaseRoom(caseId);
  useDocumentTitle(c ? c.displayId : 'Case');

  if (q.isError) {
    return (
      <div className="border border-rule bg-surface">
        <ErrorState title="Could not load this case." error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  return (
    <article aria-busy={!c || undefined}>
      {c ? <CaseHeader c={c} /> : <CaseHeaderSkeleton />}

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-labelledby="matrix-title" className="order-2 min-w-0 xl:order-1 xl:col-span-2">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 pb-2">
          <h2 id="matrix-title" className="text-18 font-semibold">
            Compare payment records
          </h2>
          {c ? <MatrixSummary c={c} /> : null}
        </div>
        <div className="overflow-x-auto rounded-lg border border-rule bg-surface" role="region" aria-label="Payment systems comparison" tabIndex={0}>
          <div className="min-w-[760px]">{c ? <StateMatrix matrix={c.matrix} /> : <StateMatrixSkeleton />}</div>
          {c && c.matrix.mismatched.length === 0 ? (
            <p className="border-t border-rule px-3 py-2 text-13 text-ink-2">
              Systems agree. Flagged by {c.ruleIds.map((r) => DETECTION_RULE_LABEL[r].toLowerCase()).join('; ')}.
            </p>
          ) : null}
        </div>
      </section>

        <div className="order-3 min-w-0 xl:order-2">{c ? <Investigation key={c.id} c={c} /> : <InvestigationSkeleton />}</div>
        <div className="order-1 xl:order-3">{c ? <CaseActions c={c} /> : <div className="rounded-lg border border-rule bg-surface p-6"><Skeleton width={140} height={20} /><Skeleton width="80%" className="mt-4" /><Skeleton width="100%" height={40} className="mt-6" /></div>}</div>
      </div>

      <ResolutionSection c={c} />

      <details className="mt-8 overflow-hidden rounded-lg border border-rule bg-surface">
        <summary className="cursor-pointer px-5 py-4 text-15 font-medium text-ink hover:bg-surface-sunk">Case details and lifecycle</summary>
        <div className="grid grid-cols-1 border-t border-rule lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)]">
        <Section title="Case details" titleId="details-title">
          {c ? <CaseDetails c={c} /> : <CaseDetailsSkeleton />}
        </Section>
        <Section
          title="Lifecycle"
          titleId="lifecycle-title"
          className="border-t border-rule lg:border-t-0 lg:border-l"
          aside={c ? <span className="tabular font-mono">{c.lifecycle.length} events</span> : null}
          bodyClassName="px-4"
        >
          {c ? <Timeline events={c.lifecycle} /> : <TimelineSkeleton rows={8} />}
        </Section>
        </div>
      </details>
    </article>
  );
}

function MatrixSummary({ c }: { c: CaseDetail }) {
  const n = c.matrix.mismatched.length;
  if (n === 0) return null;
  return (
    <p className="text-12 text-ink-2">
      <span className="tabular font-mono text-bad">{n}</span> {n === 1 ? 'system disagrees' : 'systems disagree'}: {mismatchSummary(c.matrix.mismatched)}
    </p>
  );
}
