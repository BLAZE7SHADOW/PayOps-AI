import { useEffect, useState } from 'react';
import { GW_PAYMENT_STATUS, ORDER_STATUS, type PaymentListItem } from '@payops/shared';
import { Link } from 'react-router';
import { statusLabel } from '../../lib/format';
import type { PaymentFilters } from '../../lib/query-keys';
import { useDocumentTitle } from '../../lib/use-document-title';
import { pickEnum, useUrlState } from '../../lib/use-url-state';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterBar } from '../../ui/FilterBar';
import { Input } from '../../ui/Input';
import { LoadMore } from '../../ui/Pagination';
import { PageHeader } from '../../ui/PageHeader';
import { Select } from '../../ui/Select';
import { Table } from '../../ui/Table';
import { Toggle } from '../../ui/Toggle';
import { usePayments } from './api';
import { paymentColumns } from './columns';
import { PaymentDrawer } from './PaymentDrawer';

const KEYS = ['q', 'gatewayStatus', 'orderStatus', 'mismatchOnly', 'payment'] as const;
const gatewayOptions = GW_PAYMENT_STATUS.map((s) => ({ value: s, label: statusLabel(s) }));
const orderOptions = ORDER_STATUS.map((s) => ({ value: s, label: statusLabel(s) }));

export function PaymentsPage() {
  useDocumentTitle('Payments');
  const [url, setUrl] = useUrlState(KEYS);
  const filters: PaymentFilters = {
    q: url.q,
    gatewayStatus: pickEnum(url.gatewayStatus, GW_PAYMENT_STATUS),
    orderStatus: pickEnum(url.orderStatus, ORDER_STATUS),
    mismatchOnly: url.mismatchOnly === 'true' || undefined,
  };
  const list = usePayments(filters);
  const filtered = Boolean(filters.q || filters.gatewayStatus || filters.orderStatus || filters.mismatchOnly);

  return (
    <>
      <PageHeader
        title="Payments"
        meta="Each payment as the gateway, order service, ledger and settlement see it."
      />
      <FilterBar
        end={
          filtered ? (
            <Button variant="quiet" onClick={() => setUrl({ q: undefined, gatewayStatus: undefined, orderStatus: undefined, mismatchOnly: undefined })}>
              Clear filters
            </Button>
          ) : null
        }
      >
        <SearchInput value={url.q ?? ''} onChange={(q) => setUrl({ q })} />
        <Select
          label="Gateway status"
          allLabel="Any gateway status"
          value={filters.gatewayStatus}
          options={gatewayOptions}
          onChange={(v) => setUrl({ gatewayStatus: v })}
          mono
        />
        <Select
          label="Order status"
          allLabel="Any order status"
          value={filters.orderStatus}
          options={orderOptions}
          onChange={(v) => setUrl({ orderStatus: v })}
          mono
        />
        <Toggle label="Mismatches only" pressed={Boolean(filters.mismatchOnly)} onPressedChange={(on) => setUrl({ mismatchOnly: on ? 'true' : undefined })} />
      </FilterBar>

      {list.isError && !list.data ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load payments." error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <Table<PaymentListItem>
            label="Payments"
            columns={paymentColumns}
            rows={list.items}
            rowKey={(p) => p.paymentId}
            loading={list.isPending}
            selectedKey={url.payment}
            onRowOpen={(p) => setUrl({ payment: p.paymentId }, { push: true })}
            minWidth={1024}
            empty={
              filtered ? (
                <EmptyState message="No payments match these filters." />
              ) : (
                <EmptyState
                  message="No payments yet."
                  action={
                    <Link to="/simulator" className="link">
                      Generate a scenario from the Simulator.
                    </Link>
                  }
                />
              )
            }
          />
          <LoadMore
            noun="payments"
            shown={list.items.length}
            total={list.total}
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
          />
        </>
      )}

      <PaymentDrawer paymentId={url.payment} onClose={() => setUrl({ payment: undefined })} />
    </>
  );
}

/** Debounced so typing does not fire a request per keystroke. The URL is the source of truth. */
function SearchInput({ value, onChange }: { value: string; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft.trim() || undefined), 250);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <Input
      aria-label="Search payments"
      placeholder="Payment, order or customer"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      className="w-64"
    />
  );
}
