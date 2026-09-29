import { useState } from 'react';
import { Link } from 'react-router';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_LOG_STATUS, type WebhookLogDetail, type WebhookLogItem, type WebhookLogStatus } from '@payops/shared';
import { formatDateTime, formatFullDateTime } from '../../lib/format';
import { can } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { KeyValue } from '../../ui/KeyValue';
import { Mono } from '../../ui/Mono';
import { PageHeader } from '../../ui/PageHeader';
import { LoadMore } from '../../ui/Pagination';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { useReplayWebhook, useWebhookCounts, useWebhookDetail, useWebhookLog } from './api';
import { SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, nextStep } from './webhook-log';

const STATUS_OPTIONS = WEBHOOK_LOG_STATUS.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
const EVENT_OPTIONS = WEBHOOK_EVENT_TYPES.map((e) => ({ value: e, label: e }));

const isStatus = (v: string | undefined): v is WebhookLogStatus => WEBHOOK_LOG_STATUS.some((s) => s === v);

export function WebhooksPage() {
  useDocumentTitle('Webhook events');
  const [url, setUrl] = useUrlState(['status', 'event', 'id'] as const);
  const status = isStatus(url.status) ? url.status : undefined;
  const event = WEBHOOK_EVENT_TYPES.find((e) => e === url.event);
  const list = useWebhookLog({ status, event });
  const counts = useWebhookCounts();
  const now = new Date();

  const columns: Column<WebhookLogItem>[] = [
    {
      key: 'time',
      header: 'Last activity',
      width: 152,
      render: (e) => (
        <time dateTime={e.updatedAt} title={formatFullDateTime(e.updatedAt)} className="tabular font-mono text-12 text-ink-2">
          {formatDateTime(e.updatedAt)}
        </time>
      ),
      skeleton: 112,
    },
    { key: 'event', header: 'Event', width: 160, render: (e) => <Mono className="text-12">{e.event}</Mono>, skeleton: 112 },
    { key: 'id', header: 'Event id', width: 200, render: (e) => <Mono truncate className="text-12">{e.id}</Mono>, skeleton: 128 },
    {
      key: 'status',
      header: 'Status',
      width: 136,
      render: (e) => <Tag tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Tag>,
      skeleton: 88,
    },
    { key: 'attempts', header: 'Attempts', width: 88, align: 'right', render: (e) => <span className="tabular font-mono text-12">{e.attemptCount}</span>, skeleton: 24 },
    { key: 'next', header: 'Next step', width: 184, render: (e) => <span className="text-ink-2">{nextStep(e, now)}</span>, skeleton: 120 },
    { key: 'last', header: 'Last answer', render: (e) => <span className="block truncate" title={e.lastMessage}>{e.lastHttpStatus ?? 'No answer'}: {e.lastMessage}</span>, skeleton: '60%' },
  ];

  const filtered = Boolean(status || event);
  const c = counts.data;

  return (
    <>
      <PageHeader
        title="Webhook events"
        meta={
          c
            ? `${c.processed} processed, ${c.failed} failed, ${c.dead} out of retries. Failed events retry after 1 minute, 5 minutes, 30 minutes and 2 hours.`
            : 'Every event the gateway sent to us, with each attempt. Newest activity first.'
        }
      />
      <FilterBar
        end={
          filtered ? (
            <Button variant="quiet" onClick={() => setUrl({ status: undefined, event: undefined })}>
              Clear filters
            </Button>
          ) : null
        }
      >
        <Select label="Status" allLabel="All statuses" value={status} options={STATUS_OPTIONS} onChange={(v) => setUrl({ status: v })} />
        <Select label="Event" allLabel="All events" value={event} options={EVENT_OPTIONS} onChange={(v) => setUrl({ event: v })} width={200} />
      </FilterBar>
      {list.isError && !list.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load webhook events." error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <Table<WebhookLogItem>
            label="Webhook events"
            columns={columns}
            rows={list.items}
            rowKey={(e) => e.id}
            selectedKey={url.id ?? null}
            onRowOpen={(e) => setUrl({ id: e.id })}
            loading={list.isPending}
            skeletonRows={12}
            minWidth={1024}
            empty={<EmptyState message={filtered ? 'No webhook events match these filters.' : 'No webhook events yet.'} />}
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
      <WebhookDrawer id={url.id} onClose={() => setUrl({ id: undefined })} />
    </>
  );
}

function WebhookDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const detail = useWebhookDetail(id);
  return (
    <Drawer open={Boolean(id)} onOpenChange={(open) => !open && onClose()} title="Webhook event" width={560}>
      {detail.isError ? (
        <ErrorState title="Could not load this event." error={detail.error} onRetry={() => void detail.refetch()} />
      ) : detail.data ? (
        <WebhookDetailBody d={detail.data} now={new Date()} />
      ) : (
        <div className="space-y-3 p-5">
          <Skeleton width={192} height={24} />
          <Skeleton height={128} />
        </div>
      )}
    </Drawer>
  );
}

function WebhookDetailBody({ d, now }: { d: WebhookLogDetail; now: Date }) {
  const user = useUser();
  const replay = useReplayWebhook(d.id);
  return (
    <WebhookDetailView
      d={d}
      now={now}
      canReplay={can(user?.role, 'replay')}
      pending={replay.isPending}
      error={replay.error?.message ?? null}
      onReplay={(done) => replay.mutate(undefined, { onSettled: done })}
    />
  );
}

interface DetailViewProps {
  d: WebhookLogDetail;
  now: Date;
  canReplay: boolean;
  pending: boolean;
  error: string | null;
  /** Called after the person confirms; `done` closes the confirmation when the request settles. */
  onReplay: (done: () => void) => void;
}

export function WebhookDetailView({ d, now, canReplay, pending, error, onReplay }: DetailViewProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="p-5">
      <div className="flex items-center gap-2 pr-10">
        <Mono className="text-14 font-medium">{d.event}</Mono>
        <Tag tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Tag>
      </div>
      <KeyValue
        className="mt-4"
        items={[
          { label: 'Event id', value: <Mono className="text-12">{d.id}</Mono> },
          { label: 'Gateway payment', value: <Link to={`/payments?payment=${d.gwPaymentId}`} className="link font-mono text-12">{d.gwPaymentId}</Link> },
          ...(d.gwRefundId ? [{ label: 'Gateway refund', value: <Mono className="text-12">{d.gwRefundId}</Mono> }] : []),
          { label: 'First received', value: formatFullDateTime(d.firstReceivedAt) },
          { label: 'Next step', value: nextStep(d, now) },
        ]}
      />

      <h3 className="mt-6 text-13 font-medium text-ink">Attempts</h3>
      <ol aria-label="Attempts" className="mt-2 border-t border-rule">
        {d.attempts.map((a, i) => (
          <li key={`${a.at}-${i}`} className="border-b border-rule py-2 text-13">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">
                {i + 1}. {SOURCE_LABEL[a.source]}
              </span>
              <time dateTime={a.at} className="tabular font-mono text-12 text-ink-2">{formatFullDateTime(a.at)}</time>
            </div>
            <div className="mt-0.5 text-ink-2">
              {a.httpStatus ?? 'No answer'}: {a.message}
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-6 text-13 font-medium text-ink">Payload as received</h3>
      <pre className="mt-2 overflow-x-auto border border-rule bg-surface-sunk p-3 font-mono text-12 text-ink">{JSON.stringify(d.payload, null, 2)}</pre>

      <div className="mt-6 flex items-center gap-3">
        {canReplay ? (
          confirming ? (
            <>
              <Button variant="primary" disabled={pending} onClick={() => onReplay(() => setConfirming(false))}>
                {pending ? 'Replaying' : 'Confirm replay'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={pending}>
                Cancel
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)}>Replay this event</Button>
          )
        ) : (
          <span className="text-13 text-ink-2">Replaying needs an Ops or manager account.</span>
        )}
      </div>
      {confirming ? (
        <p className="mt-2 text-13 text-ink-2">The gateway sends this event to our consumer again. Processing is safe to repeat: work that is already done is skipped.</p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-13 text-bad">{error}</p> : null}
    </div>
  );
}
