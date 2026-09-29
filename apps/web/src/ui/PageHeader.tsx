import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <header className="flex min-h-12 flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-28 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {meta ? <p className="mt-1 text-14 text-ink-2">{meta}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
