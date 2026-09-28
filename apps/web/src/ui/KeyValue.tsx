import type { ReactNode } from 'react';
import { cx } from './cx';

export interface KeyValueItem {
  label: string;
  value: ReactNode;
}

export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[128px_minmax(0,1fr)] text-13', className)}>
      {items.map((it) => (
        <div key={it.label} className="contents">
          <dt className="border-b border-rule py-2 pr-3 text-ink-2">{it.label}</dt>
          <dd className="min-w-0 border-b border-rule py-2 text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
