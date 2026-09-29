import { Link } from 'react-router';
import type { ApprovalItem } from '@payops/shared';
import { statusLabel } from '../../lib/format';
import type { ApprovalScope } from '../../lib/query-keys';
import { resolutionTone } from '../../lib/resolution';
import { tone } from '../../lib/status';
import { useDocumentTitle } from '../../lib/use-document-title';
import { pickEnum, useUrlState } from '../../lib/use-url-state';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { Money } from '../../ui/Money';
import { LoadMore } from '../../ui/Pagination';
import { PageHeader } from '../../ui/PageHeader';
import { Segmented } from '../../ui/Segmented';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { Age, CaseLink } from '../exceptions/case-cells';
import { RuleIds } from '../resolution/parts';
import { useApprovals, useBulkApprove } from './api';
import { BulkApprove } from './BulkApprove';
import { bulkEligible } from './bulk-approve';
import { ApprovalDrawer } from './ApprovalDrawer';

const SCOPES = ['pending', 'decided', 'all'] as const satisfies readonly ApprovalScope[];
const scopeOptions = [
  { value: 'pending', label: 'Pending' },
  { value: 'decided', label: 'Decided' },
  { value: 'all', label: 'All' },
] as const;

const EMPTY: Record<ApprovalScope, string> = {
  pending: 'Nothing is waiting for approval.',
  decided: 'No approvals have been decided yet.',
  all: 'No approvals yet.',
};

const columns: Column<ApprovalItem>[] = [
  { key: 'case', header: 'Case', width: 104, render: (a) => <CaseLink item={a.case} />, sortValue: (a) => a.case.displayId, skeleton: 64 },
  {
    key: 'action',
    header: 'Action',
    render: (a) => (
      <span className="block truncate" title={a.actionsSummary}>
        {a.actionsSummary}
      </span>
    ),
    skeleton: '70%',
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 128,
    align: 'right',
    render: (a) => (a.moneyMovingMinor ? <Money minor={a.moneyMovingMinor} /> : null),
    sortValue: (a) => a.moneyMovingMinor,
    skeleton: 80,
  },
  { key: 'tier', header: 'Tier', width: 104, render: (a) => <Tag tone={resolutionTone.tier(a.tier)}>{a.tier}</Tag>, sortValue: (a) => a.tier, skeleton: 56 },
  { key: 'risk', header: 'Risk', width: 96, render: (a) => <Tag tone={tone.severity(a.riskTier)}>{a.riskTier}</Tag>, skeleton: 48 },
  { key: 'rules', header: 'Rules', width: 112, render: (a) => <RuleIds ids={a.ruleIds} />, skeleton: 56 },
  {
    key: 'requested',
    header: 'Requested',
    width: 200,
    render: (a) => (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{a.requestedBy.name}</span>
        <Age iso={a.requestedAt} />
      </span>
    ),
    sortValue: (a) => -new Date(a.requestedAt).getTime(),
    skeleton: 128,
  },
  {
    key: 'status',
    header: 'Status',
    width: 120,
    render: (a) => <Tag tone={resolutionTone.approval(a.status)}>{statusLabel(a.status)}</Tag>,
    sortValue: (a) => a.status,
    skeleton: 64,
  },
];

export function ApprovalsPage() {
  useDocumentTitle('Approvals');
  const [url, setUrl] = useUrlState(['scope', 'approval'] as const);
  const scope: ApprovalScope = pickEnum(url.scope, SCOPES) ?? 'pending';
  const list = useApprovals(scope);
  const bulk = useBulkApprove();

  return (
    <>
      <PageHeader title="Approvals" meta="Proposals that policy sent to a person. The requester cannot approve their own proposal." />
      <FilterBar>
        <Segmented label="Approval scope" value={scope} options={scopeOptions} onChange={(s) => setUrl({ scope: s === 'pending' ? undefined : s })} />
      </FilterBar>

      {scope === 'pending' ? (
        <BulkApprove
          items={bulkEligible(list.items)}
          pending={bulk.isPending}
          error={bulk.error instanceof Error ? bulk.error.message : null}
          result={bulk.data ?? null}
          onApprove={(ids) => bulk.mutate({ ids, comment: '' })}
        />
      ) : null}

      {list.isError && !list.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load approvals." error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <Table<ApprovalItem>
            label="Approvals"
            columns={columns}
            rows={list.items}
            rowKey={(a) => a.id}
            loading={list.isPending}
            skeletonRows={6}
            selectedKey={url.approval}
            onRowOpen={(a) => setUrl({ approval: a.id }, { push: true })}
            minWidth={1024}
            empty={
              <EmptyState
                message={EMPTY[scope]}
                action={
                  scope === 'pending' ? (
                    <Link to="/exceptions" className="link">
                      Open the exceptions queue.
                    </Link>
                  ) : undefined
                }
              />
            }
          />
          <LoadMore
            noun="approvals"
            shown={list.items.length}
            total={list.total}
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
          />
        </>
      )}

      <ApprovalDrawer approvalId={url.approval} onClose={() => setUrl({ approval: undefined })} />
    </>
  );
}
