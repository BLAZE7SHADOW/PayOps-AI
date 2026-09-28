import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ActorType, AuditEventItem } from '@payops/shared';
import { formatDateTime, formatFullDateTime } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { Input } from '../../ui/Input';
import { Mono } from '../../ui/Mono';
import { LoadMore } from '../../ui/Pagination';
import { PageHeader } from '../../ui/PageHeader';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { useAudit } from './api';

const ACTOR_TONE: Record<ActorType, Tone> = { USER: 'neutral', AGENT: 'accent', SYSTEM: 'neutral' };

function EntityRef({ e }: { e: AuditEventItem }) {
  const to = e.entityType === 'case' ? `/cases/${e.entityId}` : e.entityType === 'payment' ? `/payments?payment=${e.entityId}` : null;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-ink-2">{e.entityType.replace(/_/g, ' ')}</span>
      {to ? (
        <Link to={to} className="link truncate font-mono text-12" title={e.entityId}>
          {e.entityId}
        </Link>
      ) : (
        <Mono truncate className="text-12">{e.entityId}</Mono>
      )}
    </span>
  );
}

const columns: Column<AuditEventItem>[] = [
  {
    key: 'time',
    header: 'Time',
    width: 152,
    render: (e) => (
      <time dateTime={e.at} title={formatFullDateTime(e.at)} className="tabular font-mono text-12 text-ink-2">
        {formatDateTime(e.at)}
      </time>
    ),
    skeleton: 112,
  },
  {
    key: 'actor',
    header: 'Actor',
    width: 200,
    render: (e) => (
      <span className="flex min-w-0 items-center gap-2">
        <Tag tone={ACTOR_TONE[e.actorType]}>{e.actorType}</Tag>
        <span className="truncate">{e.actor.name}</span>
      </span>
    ),
    skeleton: 128,
  },
  { key: 'action', header: 'Action', width: 224, render: (e) => <Mono truncate className="text-12">{e.action}</Mono>, skeleton: 144 },
  { key: 'entity', header: 'Entity', width: 256, render: (e) => <EntityRef e={e} />, skeleton: 176 },
  { key: 'summary', header: 'Summary', render: (e) => <span className="block truncate" title={e.summary}>{e.summary}</span>, skeleton: '60%' },
];

export function AuditPage() {
  useDocumentTitle('Audit log');
  const [url, setUrl] = useUrlState(['caseId', 'entityId'] as const);
  const list = useAudit({ caseId: url.caseId, entityId: url.entityId });
  const filtered = Boolean(url.caseId || url.entityId);

  return (
    <>
      <PageHeader title="Audit log" meta="Every state change, who made it and when. Newest first." />
      <FilterBar
        end={
          filtered ? (
            <Button variant="quiet" onClick={() => setUrl({ caseId: undefined, entityId: undefined })}>
              Clear filter
            </Button>
          ) : null
        }
      >
        <IdFilter value={url.caseId ?? url.entityId ?? ''} onChange={(v) => setUrl(v?.startsWith('case_') ? { caseId: v, entityId: undefined } : { entityId: v, caseId: undefined })} />
      </FilterBar>
      {list.isError && !list.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load the audit log." error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <Table<AuditEventItem>
            label="Audit log"
            columns={columns}
            rows={list.items}
            rowKey={(e) => e.id}
            loading={list.isPending}
            skeletonRows={14}
            minWidth={1024}
            empty={<EmptyState message={filtered ? 'No audit events for this id.' : 'No audit events yet.'} />}
          />
          <LoadMore
            noun="events"
            shown={list.items.length}
            total={list.total}
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
          />
        </>
      )}
    </>
  );
}

function IdFilter({ value, onChange }: { value: string; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onChange(draft.trim() || undefined);
      }}
    >
      <Input
        mono
        aria-label="Filter by case id or entity id"
        placeholder="case_, pay_, ord_ id"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && onChange(draft.trim() || undefined)}
        className="w-72 text-12"
      />
    </form>
  );
}
