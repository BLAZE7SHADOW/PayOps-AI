import { Link } from 'react-router';
import type { CaseSourceRecords as Records } from '@payops/shared';
import { formatDateTime, formatFullDateTime, formatMoney, statusLabel } from '../../lib/format';
import { ErrorState } from '../../ui/ErrorState';
import { Skeleton } from '../../ui/Skeleton';
import { useCaseSourceRecords } from './api';

export function CaseSourceRecords({ caseId }: { caseId: string }) {
  const q = useCaseSourceRecords(caseId);
  return (
    <section id="source-records" aria-labelledby="source-records-title" className="mt-8 scroll-mt-6 overflow-hidden rounded-lg border border-rule bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
        <div>
          <h2 id="source-records-title" className="text-18 font-semibold">Source records</h2>
          <p className="mt-1 text-13 text-ink-2">Current records from the payment systems, read independently of the agent’s explanation.</p>
        </div>
        <button type="button" onClick={() => void q.refetch()} disabled={q.isFetching} className="link text-13 disabled:opacity-50">
          {q.isFetching && q.data ? 'Refreshing…' : 'Refresh records'}
        </button>
      </header>
      {q.isError ? <ErrorState title="Could not load source records." error={q.error} onRetry={() => void q.refetch()} /> : q.data ? <RecordsView data={q.data} /> : <div className="space-y-3 p-5" aria-hidden="true"><Skeleton height={24} /><Skeleton height={24} /><Skeleton height={24} /></div>}
    </section>
  );
}

export function RecordsView({ data }: { data: Records }) {
  return (
    <>
      <p className="border-b border-rule px-5 py-2 text-12 text-ink-2">Read at <time dateTime={data.readAt} title={formatFullDateTime(data.readAt)}>{formatFullDateTime(data.readAt)}</time> · {data.records.length} records</p>
      {data.records.length === 0 ? <p className="px-5 py-5 text-13 text-ink-2">No linked source records found for this case.</p> : (
        <div className="overflow-x-auto" role="region" aria-label="Source records" tabIndex={0}>
          <table className="w-full min-w-[720px] text-left text-13">
            <thead className="bg-surface-sunk text-11 font-medium uppercase tracking-wide text-ink-2"><tr><th scope="col" className="px-4 py-2">System / record</th><th scope="col" className="px-4 py-2">Status</th><th scope="col" className="px-4 py-2 text-right">Amount</th><th scope="col" className="px-4 py-2">Updated</th></tr></thead>
            <tbody>
              {data.records.map((record) => (
                <tr key={`${record.kind}:${record.id}`} className="border-t border-rule align-top">
                  <td className="px-4 py-3">
                    <span className="block text-11 font-medium uppercase tracking-wide text-ink-2">{record.system} · {record.kind}</span>
                    {record.kind === 'Internal payment' ? <Link className="link font-mono text-12" to={`/payments?payment=${encodeURIComponent(record.id)}`}>{record.id}</Link> : <span className="block font-mono text-12">{record.id}</span>}
                    {record.details.length > 0 ? <details className="mt-1"><summary className="cursor-pointer text-12 text-ink-2 hover:text-ink">Inspect fields</summary><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-12">{record.details.map((field, i) => <div key={`${field.label}:${i}`} className="contents"><dt className="text-ink-2">{field.label}</dt><dd className="break-all font-mono">{field.value}</dd></div>)}</dl></details> : null}
                  </td>
                  <td className="px-4 py-3">{statusLabel(record.status)}</td>
                  <td className="px-4 py-3 text-right tabular font-mono">{record.amountMinor === null ? '—' : formatMoney(record.amountMinor)}</td>
                  <td className="px-4 py-3 tabular font-mono text-12 text-ink-2">{record.at ? <time dateTime={record.at} title={formatFullDateTime(record.at)}>{formatDateTime(record.at)}</time> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
