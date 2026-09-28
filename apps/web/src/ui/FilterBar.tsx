import type { ReactNode } from 'react';

/** One row of filters above a table (§11 Payments). */
export function FilterBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div role="search" className="flex flex-wrap items-center gap-2 pb-3">
      {children}
      {end ? <div className="ml-auto flex items-center gap-2">{end}</div> : null}
    </div>
  );
}
