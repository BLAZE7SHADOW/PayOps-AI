import type { ReactNode } from 'react';
import type { Tone } from '../lib/status';
import { cx } from './cx';

const SWATCH: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
};

const TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  neutral: 'text-ink-2',
  accent: 'text-accent',
};

interface TagProps {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}

/** Status tag: uppercase mono text with a 6px square swatch. Text always carries the meaning. */
export function Tag({ tone = 'neutral', children, title, className }: TagProps) {
  return (
    <span
      data-tone={tone}
      title={title ?? (typeof children === 'string' ? children : undefined)}
      className={cx(
        'inline-flex h-5 max-w-full items-center gap-1 rounded-xs border border-rule bg-surface px-[5px]',
        'font-mono text-11 font-medium whitespace-nowrap uppercase',
        TEXT[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cx('size-1.5 shrink-0', SWATCH[tone])} />
      <span className="truncate">{children}</span>
    </span>
  );
}
