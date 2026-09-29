import { Link } from 'react-router';
import { CASE_TYPE_LABEL, SEVERITY_RANK, type CaseListItem } from '@payops/shared';
import { ageLabel, formatFullDateTime, statusLabel } from '../../lib/format';
import { tone } from '../../lib/status';
import type { Column } from '../../ui/Table';
import { Money } from '../../ui/Money';
import { MiniMatrix } from '../../ui/MiniMatrix';
import { Tag } from '../../ui/Tag';

export function CaseLink({ item }: { item: Pick<CaseListItem, 'id' | 'displayId'> }) {
  return (
    <Link to={`/cases/${item.id}`} className="link tabular font-mono">
      {item.displayId}
    </Link>
  );
}

export function Age({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatFullDateTime(iso)} className="tabular font-mono text-ink-2">
      {ageLabel(iso)}
    </time>
  );
}

export function Signals({ signals }: { signals: CaseListItem['signals'] }) {
  const { complaintType, urgent, quarantined } = signals;
  if (!complaintType && !urgent && !quarantined) return <span className="font-mono text-ink-2">–</span>;
  return (
    // Tags that do not fit wrap onto a hidden second line instead of being clipped mid-word.
    <span className="flex h-5 flex-wrap gap-1 overflow-hidden" title={[quarantined && 'QUARANTINED TEXT', urgent && 'URGENT', complaintType && statusLabel(complaintType)].filter(Boolean).join(' · ')}>
      {quarantined ? <Tag tone="bad" title="Note contains instructions aimed at automated systems">QUARANTINED TEXT</Tag> : null}
      {urgent ? <Tag tone="warn">URGENT</Tag> : null}
      {complaintType ? <Tag>{statusLabel(complaintType)}</Tag> : null}
    </span>
  );
}

type Col = Column<CaseListItem>;

export const caseColumns = {
  case: { key: 'case', header: 'Case', width: 104, render: (c) => <CaseLink item={c} />, sortValue: (c) => c.displayId, skeleton: 64 } satisfies Col,
  type: { key: 'type', header: 'Type', width: 160, render: (c) => <span className="block truncate">{CASE_TYPE_LABEL[c.type]}</span>, sortValue: (c) => CASE_TYPE_LABEL[c.type], skeleton: 112 } satisfies Col,
  amount: { key: 'amount', header: 'Amount', width: 128, align: 'right', render: (c) => <Money minor={c.amountMinor} />, sortValue: (c) => c.amountMinor, skeleton: 80 } satisfies Col,
  disagreement: { key: 'disagreement', header: 'Disagreement', width: 112, render: (c) => <MiniMatrix mismatched={c.mismatched} />, skeleton: 88 } satisfies Col,
  severity: { key: 'severity', header: 'Severity', width: 104, render: (c) => <Tag tone={tone.severity(c.severity)}>{c.severity}</Tag>, sortValue: (c) => SEVERITY_RANK[c.severity], skeleton: 56 } satisfies Col,
  age: { key: 'age', header: 'Age', width: 64, align: 'right', render: (c) => <Age iso={c.openedAt} />, sortValue: (c) => -new Date(c.openedAt).getTime(), skeleton: 24 } satisfies Col,
  signals: { key: 'signals', header: 'Signals', render: (c) => <Signals signals={c.signals} />, skeleton: '50%' } satisfies Col,
  status: { key: 'status', header: 'Status', width: 152, render: (c) => <Tag tone={tone.caseStatus(c.status)}>{statusLabel(c.status)}</Tag>, sortValue: (c) => c.status, skeleton: 56 } satisfies Col,
};
