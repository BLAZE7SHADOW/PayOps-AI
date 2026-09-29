import { Link, useNavigate } from 'react-router';
import { RUN_STATUS, type AgentRunItem, type RunStatus } from '@payops/shared';
import { formatDateTime, statusLabel } from '../../lib/format';
import { useDocumentTitle } from '../../lib/use-document-title';
import { pickEnum, useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { Mono } from '../../ui/Mono';
import { PageHeader } from '../../ui/PageHeader';
import { Select } from '../../ui/Select';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { useRunIndex } from './api';
import { RUN_TONE, formatCost, formatDuration, runDurationMs } from './run-metrics';

const num = 'tabular font-mono text-12';

function columns(nowMs: number): Column<AgentRunItem>[] {
  const count = (key: string, header: string, pick: (r: AgentRunItem) => number): Column<AgentRunItem> => ({
    key,
    header,
    width: 72,
    align: 'right',
    render: (r) => <span className={num}>{pick(r)}</span>,
    sortValue: pick,
    skeleton: 24,
  });
  return [
    {
      key: 'run',
      header: 'Run',
      width: 168,
      render: (r) => (
        <Link to={`/runs/${r.id}`} className="link truncate font-mono text-12" title={r.id} onClick={(e) => e.stopPropagation()}>
          {r.id}
        </Link>
      ),
      skeleton: 144,
    },
    {
      key: 'case',
      header: 'Case',
      width: 160,
      render: (r) => (
        <Link to={`/cases/${r.caseId}`} className="link truncate font-mono text-12" title={r.caseId} onClick={(e) => e.stopPropagation()}>
          {r.caseId}
        </Link>
      ),
      skeleton: 120,
    },
    { key: 'status', header: 'Status', width: 144, render: (r) => <Tag tone={RUN_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</Tag>, skeleton: 104 },
    count('attempts', 'Attempts', (r) => r.attempt),
    {
      key: 'duration',
      header: 'Duration',
      width: 96,
      align: 'right',
      render: (r) => <span className={num}>{formatDuration(runDurationMs(r, nowMs))}</span>,
      sortValue: (r) => runDurationMs(r, nowMs),
      skeleton: 48,
    },
    count('llm', 'LLM', (r) => r.budget.llmCalls),
    count('jev', 'Jev', (r) => r.budget.jevCalls),
    count('tools', 'Tools', (r) => r.budget.toolCalls),
    {
      key: 'tokens',
      header: 'Tokens',
      width: 88,
      align: 'right',
      render: (r) => <span className={num}>{(r.budget.tokensIn + r.budget.tokensOut).toLocaleString('en-IN')}</span>,
      sortValue: (r) => r.budget.tokensIn + r.budget.tokensOut,
      skeleton: 40,
    },
    {
      key: 'cost',
      header: 'Cost',
      width: 88,
      align: 'right',
      render: (r) => <span className={num}>{formatCost(r.budget.costUsd)}</span>,
      sortValue: (r) => r.budget.costUsd,
      skeleton: 48,
    },
    {
      key: 'path',
      header: 'Path',
      width: 72,
      render: (r) => <Mono className="text-12">{r.path ?? '-'}</Mono>,
      skeleton: 40,
    },
    {
      key: 'started',
      header: 'Started',
      render: (r) => (
        <time dateTime={r.createdAt} className="tabular font-mono text-12 text-ink-2">
          {formatDateTime(r.createdAt)}
        </time>
      ),
      skeleton: 96,
    },
  ];
}

export function RunsPage() {
  useDocumentTitle('Agent runs');
  const navigate = useNavigate();
  const [url, setUrl] = useUrlState(['status'] as const);
  const status = pickEnum(url.status, RUN_STATUS);
  const q = useRunIndex(status);
  const rows = q.data?.items ?? [];

  return (
    <>
      <PageHeader title="Agent runs" meta="Every investigation, newest first. Counts and cost come from the run's own budget record." />
      <FilterBar
        end={
          status ? (
            <Button variant="quiet" onClick={() => setUrl({ status: undefined })}>
              Clear filter
            </Button>
          ) : null
        }
      >
        <Select<RunStatus>
          label="Status"
          allLabel="All statuses"
          value={status}
          options={RUN_STATUS.map((s) => ({ value: s, label: statusLabel(s) }))}
          onChange={(v) => setUrl({ status: v })}
        />
      </FilterBar>
      {q.isError && !q.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load agent runs." error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <Table<AgentRunItem>
          label="Agent runs"
          columns={columns(q.dataUpdatedAt || Date.now())}
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isPending}
          skeletonRows={8}
          minWidth={1100}
          onRowOpen={(r) => navigate(`/runs/${r.id}`)}
          empty={
            <EmptyState
              message={status ? 'No runs with this status.' : 'No investigations yet.'}
              action={
                status ? undefined : (
                  <Link to="/exceptions" className="link">
                    Start one from a case in Exceptions.
                  </Link>
                )
              }
            />
          }
        />
      )}
    </>
  );
}
