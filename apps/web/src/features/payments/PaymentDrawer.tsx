import { formatMoney, type PaymentDetail } from '@payops/shared';
import { Link } from 'react-router';
import { formatFullDateTime } from '../../lib/format';
import { Drawer } from '../../ui/Drawer';
import { ErrorState } from '../../ui/ErrorState';
import { Mono } from '../../ui/Mono';
import { Skeleton } from '../../ui/Skeleton';
import { StateMatrix, StateMatrixSkeleton } from '../../ui/StateMatrix';
import { Tag } from '../../ui/Tag';
import { Timeline, TimelineSkeleton } from '../../ui/Timeline';
import { usePayment } from './api';

interface Props {
  paymentId: string | undefined;
  onClose: () => void;
}

export function PaymentDrawer({ paymentId, onClose }: Props) {
  const q = usePayment(paymentId);
  return (
    <Drawer open={Boolean(paymentId)} onOpenChange={(o) => !o && onClose()} title={paymentId ? `Payment ${paymentId}` : 'Payment'}>
      {q.isError ? (
        <ErrorState className="pt-12" title="Could not load this payment." error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <DrawerHeader p={q.data} />
          <div className="px-5 pt-4">
            <h3 className="pb-2 text-13 font-semibold">State matrix</h3>
            <div className="border border-rule">{q.data ? <StateMatrix matrix={q.data.matrix} compact /> : <StateMatrixSkeleton compact />}</div>
          </div>
          <div className="px-5 pt-5 pb-6">
            <h3 className="pb-2 text-13 font-semibold">Lifecycle</h3>
            <div className="border border-rule bg-surface px-3">{q.data ? <Timeline events={q.data.lifecycle} /> : <TimelineSkeleton />}</div>
          </div>
        </>
      )}
    </Drawer>
  );
}

function method(p: PaymentDetail): string {
  if (p.card) return `${p.method} · ${p.card.network} •••• ${p.card.last4} · ${p.card.country}`;
  return p.method;
}

function DrawerHeader({ p }: { p: PaymentDetail | undefined }) {
  return (
    <header className="border-b border-rule bg-surface px-5 pt-4 pb-4">
      <p className="text-12 text-ink-2">Payment</p>
      <div className="mt-0.5 flex items-baseline justify-between gap-4 pr-10">
        {p ? <Mono className="text-16 font-medium">{p.paymentId}</Mono> : <Skeleton width={200} height={16} className="my-1" />}
        {p ? (
          <span className="tabular font-mono text-20 font-medium">{formatMoney(p.amountMinor)}</span>
        ) : (
          <Skeleton width={120} height={20} className="my-1" />
        )}
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-12 text-ink-2">
        {p ? (
          <>
            <span className="font-mono">{method(p)}</span>
            <span aria-hidden="true" className="text-ink-3">·</span>
            <span>
              Order <Mono>{p.orderId}</Mono>
            </span>
            <span aria-hidden="true" className="text-ink-3">·</span>
            <span>{p.customer.name}</span>
            <span aria-hidden="true" className="text-ink-3">·</span>
            <span title={formatFullDateTime(p.createdAt)}>
              Created <span className="tabular font-mono">{formatFullDateTime(p.createdAt)}</span>
            </span>
          </>
        ) : (
          <Skeleton width={360} height={12} />
        )}
      </div>
      {p && (p.openCase || p.mismatch) ? (
        <p className="mt-3 flex items-center gap-2 text-13">
          {p.openCase ? (
            <>
              {p.mismatch ? <Tag tone="bad">MISMATCH</Tag> : null}
              <span className="text-ink-2">Open case</span>
              <Link to={`/cases/${p.openCase.id}`} className="link font-mono">
                {p.openCase.displayId}
              </Link>
            </>
          ) : (
            <>
              <Tag tone="bad">MISMATCH</Tag>
              <span className="text-ink-2">Systems disagree. No case is open yet.</span>
            </>
          )}
        </p>
      ) : null}
    </header>
  );
}
