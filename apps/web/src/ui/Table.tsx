import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Skeleton } from './Skeleton';
import { cx } from './cx';

export interface Column<T> {
  key: string;
  header: string;
  /** Fixed width (px). Omit on exactly one column to let it take the remaining space. */
  width?: number;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /** Present when the column can be sorted client-side over loaded rows. */
  sortValue?: (row: T) => string | number;
  /** Skeleton bar width for this column while loading, e.g. '70%' or 64. */
  skeleton?: number | string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

interface TableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowOpen?: (row: T) => void;
  /** Row currently shown elsewhere (e.g. in the drawer). */
  selectedKey?: string | null;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  /** Minimum table width before horizontal scroll kicks in. */
  minWidth?: number;
  /** Header row sticks to the top of this offset inside the scroll container. */
  stickyTop?: number;
}

/**
 * Dense data table: fixed layout (no shift between skeleton and data), sticky header,
 * optional client-side sort, and keyboard row navigation (j/k or arrows, Enter opens).
 */
export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  onRowOpen,
  selectedKey,
  loading,
  skeletonRows = 10,
  empty,
  minWidth,
  stickyTop = 0,
}: TableProps<T>) {
  const [sort, setSort] = useState<SortState>(null);
  const [cursor, setCursor] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const out = [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === 'asc' ? out : out.reverse();
  }, [rows, sort, columns]);

  // Clicking a sortable header cycles asc → desc → server order.
  const cycleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));

  const focusRow = (i: number) => {
    const el = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]')[i];
    if (el) {
      setCursor(i);
      el.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'TR') return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(Math.min(cursor + 1, sorted.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(Math.max(cursor - 1, 0));
    } else if (e.key === 'Enter' && onRowOpen) {
      const row = sorted[cursor];
      if (row) onRowOpen(row);
    }
  };

  const activeCursor = Math.min(cursor, Math.max(sorted.length - 1, 0));

  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-surface" role="region" aria-label={`${label} table`} tabIndex={minWidth ? 0 : undefined}>
      <table
        aria-label={label}
        className="w-full table-fixed border-separate border-spacing-0 text-14"
        style={minWidth ? { minWidth } : undefined}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c, ci) => {
              const dir = sort?.key === c.key ? sort.dir : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                  style={{ top: stickyTop }}
                  className={cx(
                    'sticky z-10 h-10 border-b border-rule bg-surface-sunk px-3 text-13 font-medium text-ink-2 first:pl-4 last:pr-4',
                    c.align === 'right' ? 'text-right' : 'text-left',
                    afterRight(columns, ci) && 'pl-6',
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => cycleSort(c.key)}
                      className={cx(
                        'transition-color inline-flex items-center gap-1 rounded-xs hover:text-ink',
                        c.align === 'right' && 'flex-row-reverse',
                        dir && 'text-ink',
                      )}
                    >
                      {c.header}
                      <SortMark dir={dir} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef} onKeyDown={onKeyDown} aria-busy={loading || undefined}>
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={i} className="h-11">
                  {columns.map((c, ci) => (
                    <td key={c.key} className={cx('border-b border-rule px-2 first:pl-3 last:pr-3', afterRight(columns, ci) && 'pl-6')}>
                      <Skeleton
                        width={c.skeleton ?? '60%'}
                        className={c.align === 'right' ? 'ml-auto' : undefined}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row, i) => {
                const key = rowKey(row);
                const selected = selectedKey === key;
                return (
                  <tr
                    key={key}
                    data-row
                    tabIndex={i === activeCursor ? 0 : -1}
                    aria-selected={selected || undefined}
                    onFocus={() => setCursor(i)}
                    onClick={(e) => {
                      // Links and buttons inside a row handle their own clicks.
                      if ((e.target as HTMLElement).closest('a,button')) return;
                      onRowOpen?.(row);
                    }}
                    className={cx(
                      'transition-color h-11 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                      onRowOpen && 'cursor-pointer',
                      selected ? 'bg-accent-weak' : 'hover:bg-paper',
                    )}
                  >
                    {columns.map((c, ci) => (
                      <td
                        key={c.key}
                        className={cx(
                          'overflow-hidden border-b border-rule px-2 whitespace-nowrap first:pl-3 last:pr-3',
                          c.align === 'right' && 'text-right',
                          afterRight(columns, ci) && 'pl-6',
                        )}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          {!loading && sorted.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** A left-aligned column right after a right-aligned one gets extra gap so the two do not touch. */
function afterRight<T>(columns: Column<T>[], i: number): boolean {
  return i > 0 && columns[i - 1]?.align === 'right' && columns[i]?.align !== 'right';
}

/** Small up/down caret drawn in text so it inherits color. Inactive columns show a faint pair. */
function SortMark({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <span aria-hidden="true" className={cx('font-mono text-11 leading-none', dir ? 'text-ink' : 'text-ink-3')}>
      {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕'}
    </span>
  );
}
