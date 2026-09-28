import { useParams } from 'react-router';
import { DETECTION_RULE_LABEL, type CaseDetail } from '@payops/shared';
import { useDocumentTitle } from '../../lib/use-document-title';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { Section } from '../../ui/Section';
import { StateMatrix, StateMatrixSkeleton, mismatchSummary } from '../../ui/StateMatrix';
import { Timeline, TimelineSkeleton } from '../../ui/Timeline';
import { useCase } from './api';
import { CaseDetails, CaseDetailsSkeleton } from './CaseDetails';
import { CaseHeader, CaseHeaderSkeleton } from './CaseHeader';

export function CasePage() {
  const { caseId = '' } = useParams();
  const q = useCase(caseId);
  const c = q.data;
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

      <section aria-labelledby="matrix-title">
        <div className="flex h-10 items-center justify-between gap-4">
          <h2 id="matrix-title" className="text-13 font-semibold">
            State matrix
          </h2>
          {c ? <MatrixSummary c={c} /> : null}
        </div>
        <div className="border border-rule bg-surface">
          {c ? <StateMatrix matrix={c.matrix} /> : <StateMatrixSkeleton />}
          {c && c.matrix.mismatched.length === 0 ? (
            <p className="border-t border-rule px-3 py-2 text-13 text-ink-2">
              Systems agree. Flagged by {c.ruleIds.map((r) => DETECTION_RULE_LABEL[r].toLowerCase()).join('; ')}.
            </p>
          ) : null}
        </div>
      </section>

      <div className="mt-6 grid grid-cols-[minmax(0,4fr)_minmax(0,6fr)_minmax(0,3fr)] border border-rule bg-surface">
        <Section title="Case details" titleId="details-title">
          {c ? <CaseDetails c={c} /> : <CaseDetailsSkeleton />}
        </Section>
        <Section
          title="Lifecycle"
          titleId="lifecycle-title"
          className="border-l border-rule"
          aside={c ? <span className="tabular font-mono">{c.lifecycle.length} events</span> : null}
          bodyClassName="px-4"
        >
          {c ? <Timeline events={c.lifecycle} /> : <TimelineSkeleton rows={8} />}
        </Section>
        <Section title="Investigation" titleId="investigation-title" className="border-l border-rule">
          <EmptyState message="No investigation has run for this case." className="py-6" />
        </Section>
      </div>
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
