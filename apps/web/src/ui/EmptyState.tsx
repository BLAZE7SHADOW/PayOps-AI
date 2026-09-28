import type { ReactNode } from 'react';
import { cx } from './cx';

interface EmptyStateProps {
  /** One plain sentence stating what is empty. */
  message: string;
  /** The next action, usually a link. Rendered on the same line. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  return (
    <p role="status" className={cx('px-4 py-8 text-13 text-ink-2', className)}>
      {message}
      {action ? <> {action}</> : null}
    </p>
  );
}
