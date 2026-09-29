import { SYSTEMS, formatMoney, type MatrixCell, type StateMatrix as Matrix, type SystemKey } from '@payops/shared';
import { formatDateTime, formatFullDateTime, statusLabel } from '../lib/format';
import { SYSTEM_LABEL } from '../lib/status';
import { Skeleton } from './Skeleton';
import { cx } from './cx';

type RowKey = 'status' | 'amount' | 'at' | 'detail';
const ROWS: RowKey[] = ['status', 'amount', 'at', 'detail'];

interface StateMatrixProps {
  matrix: Matrix;
  /** compact: used in the payment drawer (narrower cells, smaller type). */
  compact?: boolean;
}

/**
 * The product's signature view: one payment as five systems see it (docs/05-ui-design.md §11 Case).
 * Mismatched cells get --bad-weak, a ▲ marker and an aria-label; the gateway column is the reference.
 */
export function StateMatrix({ matrix, compact }: StateMatrixProps) {
  const reference = SYSTEMS.find((s) => matrix.cells[s].reference) ?? 'GATEWAY';
  return (
    <table
      aria-label="State matrix"
      className={cx('w-full table-fixed border-separate border-spacing-0 bg-surface', compact ? 'text-12' : 'text-13')}
    >
      <colgroup>
        <col style={{ width: compact ? 72 : 96 }} />
        {SYSTEMS.map((s) => (
          <col key={s} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="h-9 border-b border-rule bg-surface-sunk px-3">
            <span className="sr-only">Field</span>
          </th>
          {SYSTEMS.map((s) => {
            const mismatched = matrix.cells[s].mismatch;
            return (
              <th
                key={s}
                scope="col"
                className={cx(
                  'h-9 border-b border-l border-rule bg-surface-sunk text-left font-medium text-ink',
                  compact ? 'px-2' : 'px-3',
                )}
              >
                <span className={cx('flex', compact ? 'flex-col py-1 leading-tight' : 'items-center gap-2')}>
                  <span className="truncate">{SYSTEM_LABEL[s]}</span>
                  {s === reference ? (
                    <span className={cx('font-mono font-medium tracking-[0.02em] text-accent', compact ? 'text-[10px]' : 'text-11')}>REFERENCE</span>
                  ) : mismatched ? (
                    <span className="sr-only">(disagrees)</span>
                  ) : null}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row, ri) => (
          <tr key={row}>
            <th
              scope="row"
              className={cx(
                'px-3 text-left align-top font-normal text-ink-2',
                compact ? 'py-1.5' : 'py-2',
                ri < ROWS.length - 1 && 'border-b border-rule',
              )}
            >
              {row}
            </th>
            {SYSTEMS.map((s) => (
              <Cell key={s} cell={matrix.cells[s]} row={row} compact={compact} last={ri === ROWS.length - 1} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cell({ cell, row, compact, last }: { cell: MatrixCell; row: RowKey; compact?: boolean; last: boolean }) {
  const bad = cell.mismatch;
  const label =
    row === 'status' && bad
      ? `${SYSTEM_LABEL[cell.system]} status ${cell.status ?? 'none'}: disagrees with the reference`
      : undefined;
  return (
    <td
      aria-label={label}
      data-mismatch={bad || undefined}
      className={cx(
        'border-l border-rule align-top',
        compact ? 'px-2 py-1.5' : 'px-3 py-2',
        !last && 'border-b',
        bad && 'bg-bad-weak',
      )}
    >
      <CellValue cell={cell} row={row} />
    </td>
  );
}

const Dash = () => <span className="font-mono text-ink-2">–</span>;

function CellValue({ cell, row }: { cell: MatrixCell; row: RowKey }) {
  switch (row) {
    case 'status':
      if (cell.status === null) return <Dash />;
      return (
        <span className={cx('flex items-center gap-1 font-mono font-medium', cell.mismatch ? 'text-bad' : 'text-ink')}>
          <span className="truncate" title={statusLabel(cell.status)}>
            {statusLabel(cell.status)}
          </span>
          {cell.mismatch ? (
            <span aria-hidden="true" data-marker className="text-11">
              ▲
            </span>
          ) : null}
        </span>
      );
    case 'amount':
      return cell.amountMinor === null ? <Dash /> : <span className="tabular font-mono">{formatMoney(cell.amountMinor)}</span>;
    case 'at':
      return cell.at === null ? (
        <Dash />
      ) : (
        <time dateTime={cell.at} title={formatFullDateTime(cell.at)} className="tabular font-mono text-ink-2">
          {formatDateTime(cell.at)}
        </time>
      );
    case 'detail':
      return cell.detail === null ? <Dash /> : <span className="block text-ink-2">{cell.detail}</span>;
  }
}

/** Mirrors StateMatrix geometry exactly so nothing moves when data arrives. */
export function StateMatrixSkeleton({ compact }: { compact?: boolean }) {
  return (
    <table aria-hidden="true" className={cx('w-full table-fixed border-separate border-spacing-0 bg-surface', compact ? 'text-12' : 'text-13')}>
      <colgroup>
        <col style={{ width: compact ? 72 : 96 }} />
        {SYSTEMS.map((s) => (
          <col key={s} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th className="h-9 border-b border-rule bg-surface-sunk" />
          {SYSTEMS.map((s) => (
            <th key={s} className={cx('h-9 border-b border-l border-rule bg-surface-sunk text-left font-medium text-ink', compact ? 'px-2' : 'px-3')}>
              {SYSTEM_LABEL[s]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row, ri) => (
          <tr key={row}>
            <th scope="row" className={cx('px-3 text-left font-normal text-ink-2', compact ? 'py-1.5' : 'py-2', ri < ROWS.length - 1 && 'border-b border-rule')}>
              {row}
            </th>
            {SYSTEMS.map((s) => (
              <td key={s} className={cx('border-l border-rule', compact ? 'px-2 py-1.5' : 'px-3 py-2', ri < ROWS.length - 1 && 'border-b')}>
                <span className="flex h-5 items-center">
                  <Skeleton width={row === 'detail' ? '80%' : '55%'} />
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The systems that disagree, in matrix order, as plain labels. */
export function mismatchSummary(mismatched: SystemKey[]): string {
  const ordered = SYSTEMS.filter((s) => mismatched.includes(s)).map((s) => SYSTEM_LABEL[s]);
  return ordered.join(', ');
}
