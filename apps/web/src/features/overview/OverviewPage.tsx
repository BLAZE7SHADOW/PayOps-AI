import { Link, useNavigate } from 'react-router';
import type { CaseListItem } from '@payops/shared';
import { formatTime } from '../../lib/format';
import { useDocumentTitle } from '../../lib/use-document-title';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { PageHeader } from '../../ui/PageHeader';
import { Table } from '../../ui/Table';
import { caseColumns } from '../exceptions/case-cells';
import { useOverview } from './api';
import { ExceptionsChart, ExceptionsChartSkeleton } from './ExceptionsChart';
import { Figures } from './Figures';
import { ValidatorOutcomes } from './ValidatorOutcomes';

const oldestColumns = [
  caseColumns.case,
  { ...caseColumns.type, width: undefined },
  { ...caseColumns.amount, width: 120 },
  { ...caseColumns.age, width: 56 },
];

export function OverviewPage() {
  useDocumentTitle('Overview');
  const q = useOverview();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Overview"
        meta={q.data ? <span>As of <span className="tabular font-mono">{formatTime(new Date(q.dataUpdatedAt).toISOString())}</span></span> : ' '}
      />
      {q.isError ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load the overview." error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <>
          <Figures data={q.data} />
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12">
            <section aria-labelledby="chart-title" className="min-w-0 lg:col-span-7">
              <div className="flex h-10 items-center">
                <h2 id="chart-title" className="text-18 font-semibold">
                  Exceptions by type, last 14 days
                </h2>
              </div>
              <div className="border border-rule bg-surface">
                {q.data ? <ExceptionsChart data={q.data.exceptionsByType} /> : <ExceptionsChartSkeleton />}
              </div>
            </section>
            <section aria-labelledby="validator-title" className="min-w-0 lg:col-span-5">
              <div className="flex h-10 items-center">
                <h2 id="validator-title" className="text-18 font-semibold">
                  Validator outcomes, last 7 days
                </h2>
              </div>
              <ValidatorOutcomes data={q.data?.validatorOutcomes7d} />
            </section>
            <section aria-labelledby="oldest-title" className="min-w-0 lg:col-span-12">
              <div className="flex h-10 items-center justify-between">
                <h2 id="oldest-title" className="text-18 font-semibold">
                  Oldest open cases
                </h2>
                <Link to="/exceptions" className="link text-12">
                  All exceptions
                </Link>
              </div>
              <Table<CaseListItem>
                label="Oldest open cases"
                columns={oldestColumns}
                rows={q.data?.oldestOpen ?? []}
                rowKey={(c) => c.id}
                loading={!q.data}
                skeletonRows={5}
                onRowOpen={(c) => navigate(`/cases/${c.id}`)}
                empty={
                  <EmptyState
                    message="No open exceptions."
                    action={
                      <Link to="/simulator" className="link">
                        Generate a scenario from the Simulator.
                      </Link>
                    }
                  />
                }
              />
            </section>
          </div>
        </>
      )}
    </>
  );
}
