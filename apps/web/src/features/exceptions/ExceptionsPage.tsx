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
import { Toggle } from '../../ui/Toggle';
import { useSession } from '../../lib/session';
import { useCases } from './api';
import { caseColumns } from './case-cells';
import { SavedViews } from './SavedViews';
import { VIEW_URL_KEYS, filtersFromUrl, hasFilters, sameFilters, urlPatchFromFilters } from './saved-views';
import { useDeleteView, useSaveView, useSavedViews } from '../workflow/api';

const SCOPES = ['open', 'closed', 'all'] as const;
const scopeOptions = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
] as const;
const typeOptions = CASE_TYPES.map((t) => ({ value: t, label: CASE_TYPE_LABEL[t] }));
const severityOptions = SEVERITIES.map((s) => ({ value: s, label: s }));
const ASSIGNEES = ['me', 'unassigned'] as const;
const assigneeOptions = [
  { value: 'me', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
] as const;

const columns = [
  caseColumns.case,
  caseColumns.type,
  caseColumns.amount,
  caseColumns.disagreement,
  caseColumns.severity,
  caseColumns.age,
  caseColumns.due,
  caseColumns.assignee,
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
  const [url, setUrl] = useUrlState(VIEW_URL_KEYS);
  const me = useSession().data;
  const assignee = pickEnum(url.assignee, ASSIGNEES);
  const filters: CaseFilters = {
    scope: pickEnum(url.scope, SCOPES) ?? 'open',
    type: pickEnum(url.type, CASE_TYPES),
    severity: pickEnum(url.severity, SEVERITIES),
    q: url.q?.trim() || undefined,
    // `me` waits for the session; until then the list is unfiltered rather than wrongly empty.
    assigneeId: assignee === 'unassigned' ? 'unassigned' : assignee === 'me' ? me?.id : undefined,
    overdue: url.overdue === 'true' ? true : undefined,
  };
  const list = useCases(filters);
  const rows = list.items;
  const views = useSavedViews();
  const saveView = useSaveView();
  const deleteView = useDeleteView();
  const current = filtersFromUrl(url);
  const activeView = hasFilters(current) ? views.data?.items.find((v) => sameFilters(v.filters, current)) : undefined;
  const narrowed = Boolean(filters.type || filters.severity || filters.q || assignee || filters.overdue);

  return (
    <>
      <PageHeader title="Exceptions" meta="Cases ordered by priority: severity, amount and age." />
      <FilterBar
        end={
          narrowed ? (
            <Button variant="quiet" onClick={() => setUrl({ type: undefined, severity: undefined, q: undefined, assignee: undefined, overdue: undefined })}>
              Clear filters
            </Button>
          ) : null
        }
      >
        <Segmented label="Case scope" value={filters.scope} options={scopeOptions} onChange={(scope) => setUrl({ scope: scope === 'open' ? undefined : scope })} />
        <Select label="Case type" allLabel="All types" value={filters.type} options={typeOptions} onChange={(v) => setUrl({ type: v })} width={192} />
        <Select label="Severity" allLabel="Any severity" value={filters.severity} options={severityOptions} onChange={(v) => setUrl({ severity: v })} mono width={152} />
        <Select label="Assignee" allLabel="Anyone" value={assignee} options={assigneeOptions} onChange={(v) => setUrl({ assignee: v })} width={168} />
        <Toggle label="Overdue only" pressed={Boolean(filters.overdue)} onPressedChange={(on) => setUrl({ overdue: on ? 'true' : undefined })} />
        {filters.q ? (
          <span className="inline-flex items-center gap-2 text-13 text-ink-2">
            Case <Tag tone="accent">{filters.q}</Tag>
          </span>
        ) : null}
        <SavedViews
          views={views.data?.items ?? []}
          activeId={activeView?.id}
          canSave={hasFilters(current)}
          pending={saveView.isPending || deleteView.isPending}
          error={saveView.isError ? saveView.error.message : deleteView.isError ? deleteView.error.message : null}
          onApply={(f) => setUrl(urlPatchFromFilters(f))}
          onSave={(name) => saveView.mutate({ name, filters: current })}
          onDelete={(id) => deleteView.mutate(id)}
        />
      </FilterBar>

      <OverdueNotice hidden={filters.scope !== 'open' || Boolean(filters.overdue)} onShow={() => setUrl({ overdue: 'true' })} />

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

/** One line above the queue when open cases are past their due time (D067). */
function OverdueNotice({ hidden, onShow }: { hidden: boolean; onShow: () => void }) {
  const overdue = useCases({ scope: 'open', overdue: true });
  const n = overdue.total ?? 0;
  if (hidden || n === 0) return null;
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-bad bg-bad-weak px-4 py-2 text-13 text-ink">
      <span>
        <span className="tabular font-mono font-semibold">{n}</span> open {n === 1 ? 'case is' : 'cases are'} past {n === 1 ? 'its' : 'their'} due time.
      </span>
      <Button variant="quiet" size="sm" onClick={onShow}>
        Show overdue
      </Button>
    </div>
  );
}
