import { Link } from 'react-router';
import type { PaymentListItem } from '@payops/shared';
import { statusLabel } from '../../lib/format';
import { tone } from '../../lib/status';
import type { Column } from '../../ui/Table';
import { Money } from '../../ui/Money';
import { Mono } from '../../ui/Mono';
import { Tag } from '../../ui/Tag';
import { Age } from '../exceptions/case-cells';

type Col = Column<PaymentListItem>;

const NotExpected = () => (
  <span className="font-mono text-12 text-ink-2" title="Not expected for this payment">
    N/A
  </span>
);

export const paymentColumns: Col[] = [
  { key: 'payment', header: 'Payment', width: 128, render: (p) => <Mono truncate className="text-12">{p.paymentId}</Mono>, skeleton: 112 },
  { key: 'order', header: 'Order', width: 104, render: (p) => <Mono truncate className="text-12 text-ink-2">{p.orderId}</Mono>, skeleton: 112 },
  {
    key: 'customer',
    header: 'Customer',
    render: (p) => (
      <span className="block truncate" title={`${p.customer.name} · ${p.customer.emailMasked}`}>
        {p.customer.name}
        <span className="ml-2 font-mono text-12 text-ink-2">{p.customer.emailMasked}</span>
      </span>
    ),
    sortValue: (p) => p.customer.name,
    skeleton: '70%',
  },
  { key: 'amount', header: 'Amount', width: 112, align: 'right', render: (p) => <Money minor={p.amountMinor} />, sortValue: (p) => p.amountMinor, skeleton: 72 },
  { key: 'gateway', header: 'Gateway', width: 112, render: (p) => <Tag tone={tone.gateway(p.gatewayStatus)}>{statusLabel(p.gatewayStatus)}</Tag>, sortValue: (p) => p.gatewayStatus, skeleton: 64 },
  { key: 'internal', header: 'Internal', width: 96, render: (p) => <Tag tone={tone.internal(p.internalStatus)}>{statusLabel(p.internalStatus)}</Tag>, sortValue: (p) => p.internalStatus, skeleton: 64 },
  { key: 'ledger', header: 'Ledger', width: 88, render: (p) => (p.ledger === 'NOT_EXPECTED' ? <NotExpected /> : <Tag tone={tone.ledger(p.ledger)}>{p.ledger}</Tag>), skeleton: 56 },
  {
    key: 'settlement',
    header: 'Settlement',
    width: 96,
    render: (p) => (p.settlement === 'NOT_EXPECTED' ? <NotExpected /> : <Tag tone={tone.settlement(p.settlement)}>{p.settlement}</Tag>),
    skeleton: 64,
  },
  {
    key: 'case',
    header: 'Case',
    width: 96,
    render: (p) =>
      p.openCase ? (
        <Link to={`/cases/${p.openCase.id}`} className="link tabular font-mono">
          {p.openCase.displayId}
        </Link>
      ) : p.mismatch ? (
        <Tag tone="bad" title="Systems disagree and no case is open yet">
          MISMATCH
        </Tag>
      ) : null,
    skeleton: 56,
  },
  { key: 'created', header: 'Created', width: 80, align: 'right', render: (p) => <Age iso={p.createdAt} />, sortValue: (p) => -new Date(p.createdAt).getTime(), skeleton: 24 },
];
