import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <header className="flex min-h-10 items-end justify-between gap-4 pb-4">
      <div className="min-w-0">
        <h1 className="text-20 font-semibold text-ink">{title}</h1>
        {meta ? <p className="mt-0.5 text-13 text-ink-2">{meta}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
