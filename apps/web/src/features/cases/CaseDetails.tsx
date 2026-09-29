import { Link } from 'react-router';
import { DETECTION_RULE_LABEL, type CaseDetail, type CaseNote } from '@payops/shared';
import { formatDateTime, formatFullDateTime, titleCase } from '../../lib/format';
import { KeyValue, type KeyValueItem } from '../../ui/KeyValue';
import { Mono } from '../../ui/Mono';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';

function refs(c: CaseDetail): KeyValueItem[] {
  const r = c.entityRefs;
  const items: KeyValueItem[] = [];
  if (r.paymentId)
    items.push({
      label: 'Payment',
      value: (
        <Link to={`/payments?payment=${r.paymentId}`} className="link block truncate font-mono text-12" title={r.paymentId}>
          {r.paymentId}
        </Link>
      ),
    });
  if (r.gwPaymentId) items.push({ label: 'Gateway payment', value: <Mono truncate className="text-12">{r.gwPaymentId}</Mono> });
  if (r.orderId) items.push({ label: 'Order', value: <Mono truncate className="text-12">{r.orderId}</Mono> });
  if (r.refundId) items.push({ label: 'Refund', value: <Mono truncate className="text-12">{r.refundId}</Mono> });
  if (c.customer)
    items.push({
      label: 'Customer',
      value: (
        <span className="block truncate" title={`${c.customer.name} · ${c.customer.emailMasked}`}>
          {c.customer.name} <span className="font-mono text-12 text-ink-2">{c.customer.emailMasked}</span>
        </span>
      ),
    });
  if (c.merchant) items.push({ label: 'Merchant', value: c.merchant.name });
  if (r.batchId) items.push({ label: 'Batch', value: <Mono truncate className="text-12">{r.batchId}</Mono> });
  return items;
}

export function CaseDetails({ c }: { c: CaseDetail }) {
  return (
    <div className="px-4 pb-4">
      <KeyValue items={refs(c)} />

      <h3 className="pt-4 pb-1 text-12 font-medium text-ink-2">Detection rules</h3>
      <ul className="text-13">
        {c.ruleIds.map((r) => (
          <li key={r} className="flex gap-2 border-b border-rule py-2">
            <span className="w-6 shrink-0 font-mono text-12 text-ink-2">{r.split('_')[0]}</span>
            <span>{DETECTION_RULE_LABEL[r]}</span>
          </li>
        ))}
      </ul>

      {c.resolution ? (
        <>
          <h3 className="pt-4 pb-1 text-12 font-medium text-ink-2">Resolution</h3>
          <p className="text-13">{c.resolution.summary}</p>
          <p className="mt-1 text-12 text-ink-2">
            By {titleCase(c.resolution.by)}
            {c.resolvedAt ? (
              <>
                {' · '}
                <span className="tabular font-mono">{formatFullDateTime(c.resolvedAt)}</span>
              </>
            ) : null}
          </p>
        </>
      ) : null}

      <h3 className="pt-4 pb-2 text-12 font-medium text-ink-2">Customer and merchant notes</h3>
      <p className="mb-3 text-13 text-ink-2">Notes can help explain a case, but cannot authorize an action. Text flagged as instructions to automated systems is quarantined and excluded from model context.</p>
      {c.notes.length === 0 ? (
        <p className="text-13 text-ink-2">No customer or merchant notes.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {c.notes.map((n) => (
            <Note key={n.id} note={n} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Untrusted text: rendered strictly as plain text (React escapes it), never as markup or links. */
function Note({ note }: { note: CaseNote }) {
  return (
    <li>
      <p className="flex items-center justify-between pb-1 text-12 text-ink-2">
        <span className="font-mono text-11 font-medium tracking-[0.02em]">{note.authorType}</span>
        <time dateTime={note.at} className="tabular font-mono">
          {formatDateTime(note.at)}
        </time>
      </p>
      {note.quarantined ? (
        <div className="border border-b-0 border-bad bg-bad-weak px-3 py-2 text-12 text-bad">
          <Tag tone="bad">QUARANTINED TEXT</Tag>
          <p className="mt-1.5">Contains instructions aimed at automated systems. Not shared with any model.</p>
        </div>
      ) : null}
      <blockquote
        className={
          note.quarantined
            ? 'border border-bad bg-surface-sunk px-3 py-2 text-13 break-words whitespace-pre-wrap text-ink'
            : 'border border-rule bg-surface-sunk px-3 py-2 text-13 break-words whitespace-pre-wrap text-ink'
        }
      >
        {note.text}
      </blockquote>
    </li>
  );
}

export function CaseDetailsSkeleton() {
  return (
    <div className="px-4 pb-4" aria-hidden="true">
      <div className="grid grid-cols-[128px_minmax(0,1fr)]">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="contents">
            <span className="flex h-9 items-center border-b border-rule">
              <Skeleton width={64} />
            </span>
            <span className="flex h-9 items-center border-b border-rule">
              <Skeleton width={i % 2 ? '60%' : '80%'} />
            </span>
          </div>
        ))}
      </div>
      <div className="pt-4 pb-1">
        <Skeleton width={96} height={10} />
      </div>
      <span className="flex h-9 items-center border-b border-rule">
        <Skeleton width="75%" />
      </span>
      <div className="pt-4 pb-2">
        <Skeleton width={48} height={10} />
      </div>
      <Skeleton height={64} />
    </div>
  );
}
