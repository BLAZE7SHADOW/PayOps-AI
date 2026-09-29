import { useState } from 'react';
import { Link } from 'react-router';
import { formatMoney, type AgentRunItem, type CaseSourceRecord, type CaseSourceRecords, type ExecutionRecordFact, type ResolutionItem } from '@payops/shared';
import { formatFullDateTime, statusLabel } from '../../lib/format';
import { Drawer } from '../../ui/Drawer';
import { Tag } from '../../ui/Tag';

interface Props {
  refId: string | null;
  onClose: () => void;
  onOpen: (ref: string) => void;
  caseId: string;
  run: AgentRunItem | undefined;
  records: CaseSourceRecords | undefined;
  resolution: ResolutionItem | undefined;
}

const factValue = (key: string, value: string | number | boolean) => (key.endsWith('Minor') && typeof value === 'number' ? formatMoney(value) : String(value));
const amount = (minor: number | null) => (minor === null ? 'none' : formatMoney(minor));

/** Earliest recorded before-state per record id across the resolution's executed steps. */
function beforeById(resolution: ResolutionItem | undefined): Map<string, ExecutionRecordFact> {
  const map = new Map<string, ExecutionRecordFact>();
  for (const step of resolution?.executions ?? []) for (const fact of step.before ?? []) if (!map.has(fact.id)) map.set(fact.id, fact);
  return map;
}

/** Opens the exact record or evidence behind a claim, without leaving the case page. */
export function RecordDrawer({ refId, onClose, onOpen, caseId, run, records, resolution }: Props) {
  return (
    <Drawer open={Boolean(refId)} onOpenChange={(open) => { if (!open) onClose(); }} title="Record detail" width={480}>
      {refId ? <Body refId={refId} onOpen={onOpen} caseId={caseId} run={run} records={records} resolution={resolution} /> : null}
    </Drawer>
  );
}

function Body({ refId, onOpen, caseId, run, records, resolution }: Omit<Props, 'onClose'> & { refId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true));
    } catch {
      setCopied(false);
    }
  };
  const isEvidence = refId.startsWith('ev_');
  const evidence = isEvidence ? run?.evidence.find((e) => e.id === refId) : undefined;
  const recordId = isEvidence ? evidence?.entityRef : refId.replace(/^rec:/, '');
  const current = recordId ? records?.records.find((r) => r.id === recordId) : undefined;
  const before = recordId ? beforeById(resolution).get(recordId) : undefined;
  const citing = evidence ? (run?.findings ?? []).filter((f) => f.evidenceIds.includes(evidence.id)) : [];

  if (isEvidence && !evidence) return <div className="p-6 pt-14"><h2 className="text-18 font-semibold">Evidence not found</h2><p className="mt-2 text-14 text-ink-2">{refId} is not part of the latest run. Open the run details to find it.</p></div>;
  if (!isEvidence && !current && !before) return <div className="p-6 pt-14"><h2 className="text-18 font-semibold">Record not found</h2><p className="mt-2 text-14 text-ink-2">No current source record matches this id. Refresh the case and try again.</p></div>;

  return (
    <div className="space-y-5 p-6 pt-14">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Tag>{evidence ? evidence.system : current?.system ?? before?.system ?? 'RECORD'}</Tag>
          <span className="font-mono text-12 text-ink-2">{isEvidence ? refId : current?.kind ?? before?.kind}</span>
        </div>
        <h2 className="mt-2 font-mono text-16 font-semibold break-all">{recordId}</h2>
      </header>

      {evidence ? (
        <section aria-label="Evidence as read">
          <h3 className="text-14 font-semibold">As read by the investigation</h3>
          <p className="mt-1 text-12 text-ink-2">Read at {formatFullDateTime(evidence.observedAt)} by {evidence.source}. These values were captured by code, not written by a model.</p>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border border-rule bg-surface p-3 text-13">
            {Object.entries(evidence.facts).map(([key, value]) => (
              <div key={key} className="contents"><dt className="text-ink-2">{key}</dt><dd className="font-mono break-all">{factValue(key, value)}</dd></div>
            ))}
          </dl>
        </section>
      ) : null}

      {before ? (
        <section aria-label="Before the action">
          <h3 className="text-14 font-semibold">Before the action</h3>
          <p className="mt-1 text-13">{statusLabel(before.status)} · <span className="font-mono">{amount(before.amountMinor)}</span></p>
        </section>
      ) : null}

      <section aria-label="Current record">
        <h3 className="text-14 font-semibold">Now</h3>
        {current ? <CurrentRecord record={current} readAt={records?.readAt} /> : <p className="mt-1 text-13 text-ink-2">No current source record has this id{isEvidence ? ', so this evidence cannot be compared with live data' : ''}.</p>}
      </section>

      {citing.length ? (
        <section aria-label="Findings that cite this evidence">
          <h3 className="text-14 font-semibold">Findings that cite this evidence</h3>
          <ul className="mt-2 space-y-2 text-13">{citing.map((f) => <li key={f.id} className="border border-rule bg-surface p-2"><span className="font-mono text-12 text-ink-2">{f.id}</span> {f.statement}</li>)}</ul>
        </section>
      ) : null}

      {evidence && run ? <p className="text-12 text-ink-2">Other evidence in this run: {run.evidence.filter((e) => e.id !== refId).slice(0, 8).map((e) => <button key={e.id} type="button" className="link mr-2 font-mono" onClick={() => onOpen(e.id)}>[{e.id}]</button>)}</p> : null}

      <footer className="flex flex-wrap gap-x-4 gap-y-2 border-t border-rule pt-4 text-13">
        {run ? <Link className="link" to={`/runs/${run.id}`}>Open run details</Link> : null}
        <Link className="link" to={`/audit?caseId=${encodeURIComponent(caseId)}`}>Open audit trail</Link>
        {resolution ? <Link className="link" to={`/audit?entityId=${encodeURIComponent(resolution.id)}`}>Audit events for the action</Link> : null}
        {current?.kind === 'Internal payment' ? <Link className="link" to={`/payments?payment=${encodeURIComponent(current.id)}`}>Open payment details</Link> : null}
        <button type="button" className="link" onClick={copy}>{copied ? 'Link copied' : 'Copy link to this record'}</button>
      </footer>
    </div>
  );
}

function CurrentRecord({ record, readAt }: { record: CaseSourceRecord; readAt: string | undefined }) {
  return (
    <div className="mt-1 text-13">
      <p>{statusLabel(record.status)} · <span className="font-mono">{amount(record.amountMinor)}</span></p>
      {readAt ? <p className="mt-1 text-12 text-ink-2">Read at {formatFullDateTime(readAt)}</p> : null}
      {record.details.length ? (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border border-rule bg-surface p-3 text-12">
          {record.details.map((d, i) => <div key={`${d.label}:${i}`} className="contents"><dt className="text-ink-2">{d.label}</dt><dd className="font-mono break-all">{d.value}</dd></div>)}
        </dl>
      ) : null}
    </div>
  );
}
