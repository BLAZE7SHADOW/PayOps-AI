import { Link, useNavigate } from 'react-router';
import { CASE_TYPES, CASE_TYPE_LABEL, SEVERITIES, type CaseListItem } from '@payops/shared';
import type { CaseFilters } from '../../lib/query-keys';
import { useDocumentTitle } from '../../lib/use-document-title';
import { pickEnum, useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { LoadMore } from '../../ui/Pagination';
import { PageHeader } from '../../ui/PageHeader';
import { Segmented } from '../../ui/Segmented';
import { Select } from '../../ui/Select';
import { Table } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { useCases } from './api';
import { caseColumns } from './case-cells';

const SCOPES = ['open', 'closed', 'all'] as const;
const scopeOptions = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
] as const;
const typeOptions = CASE_TYPES.map((t) => ({ value: t, label: CASE_TYPE_LABEL[t] }));
const severityOptions = SEVERITIES.map((s) => ({ value: s, label: s }));

const columns = [
  caseColumns.case,
  caseColumns.type,
  caseColumns.amount,
  caseColumns.disagreement,
  caseColumns.severity,
  caseColumns.age,
  caseColumns.signals,
  caseColumns.status,
];

const EMPTY: Record<(typeof SCOPES)[number], string> = {
  open: 'No open exceptions.',
  closed: 'No closed cases yet.',
  all: 'No cases yet.',
};

export function ExceptionsPage() {
  useDocumentTitle('Exceptions');
  const navigate = useNavigate();
  const [url, setUrl] = useUrlState(['scope', 'type', 'severity', 'q'] as const);
  const filters: CaseFilters = {
    scope: pickEnum(url.scope, SCOPES) ?? 'open',
    type: pickEnum(url.type, CASE_TYPES),
    severity: pickEnum(url.severity, SEVERITIES),
    q: url.q?.trim() || undefined,
  };
  const list = useCases(filters);
  const rows = list.items;
  const narrowed = Boolean(filters.type || filters.severity || filters.q);

  return (
    <>
      <PageHeader title="Exceptions" meta="Cases ordered by priority: severity, amount and age." />
      <FilterBar
        end={
          narrowed ? (
            <Button variant="quiet" onClick={() => setUrl({ type: undefined, severity: undefined, q: undefined })}>
              Clear filters
            </Button>
          ) : null
        }
      >
        <Segmented label="Case scope" value={filters.scope} options={scopeOptions} onChange={(scope) => setUrl({ scope: scope === 'open' ? undefined : scope })} />
        <Select label="Case type" allLabel="All types" value={filters.type} options={typeOptions} onChange={(v) => setUrl({ type: v })} width={192} />
        <Select label="Severity" allLabel="Any severity" value={filters.severity} options={severityOptions} onChange={(v) => setUrl({ severity: v })} mono width={152} />
        {filters.q ? (
          <span className="inline-flex items-center gap-2 text-13 text-ink-2">
            Case <Tag tone="accent">{filters.q}</Tag>
          </span>
        ) : null}
      </FilterBar>

      {list.isError && !list.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load exceptions." error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <Table<CaseListItem>
            label="Exceptions"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            loading={list.isPending}
            onRowOpen={(c) => navigate(`/cases/${c.id}`)}
            minWidth={1024}
            empty={
              narrowed ? (
                <EmptyState message={filters.q ? `No case ${filters.q} in this view.` : 'No cases match these filters.'} />
              ) : (
                <EmptyState
                  message={EMPTY[filters.scope]}
                  action={
                    filters.scope === 'closed' ? undefined : (
                      <Link to="/simulator" className="link">
                        Generate a scenario from the Simulator.
                      </Link>
                    )
                  }
                />
              )
            }
          />
          <LoadMore
            noun="cases"
            shown={rows.length}
            total={filters.q ? undefined : list.total}
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
          />
        </>
      )}
    </>
  );
}
