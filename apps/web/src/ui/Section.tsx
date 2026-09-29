import type { ReactNode } from 'react';
import { cx } from './cx';

interface SectionProps {
  title: string;
  titleId?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** A restrained panel for a substantial page area. */
export function Section({ title, titleId, aside, children, className, bodyClassName }: SectionProps) {
  return (
    <section aria-labelledby={titleId} className={cx('min-w-0 bg-surface', className)}>
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-rule px-5 py-2">
        <h2 id={titleId} className="text-16 font-semibold text-ink">
          {title}
        </h2>
        {aside ? <div className="min-w-0 text-12 text-ink-2">{aside}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
