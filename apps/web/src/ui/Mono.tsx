import type { HTMLAttributes } from 'react';
import { cx } from './cx';

interface MonoProps extends HTMLAttributes<HTMLSpanElement> {
  /** Truncate with an ellipsis; the full value goes into the title tooltip. */
  truncate?: boolean;
  children: string | number;
}

export function Mono({ truncate, className, children, ...rest }: MonoProps) {
  return (
    <span
      className={cx('tabular font-mono', truncate && 'block truncate', className)}
      title={truncate ? String(children) : undefined}
      {...rest}
    >
      {children}
    </span>
  );
}
