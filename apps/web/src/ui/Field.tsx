import { useId, type ReactNode } from 'react';
import { cx } from './cx';

interface FieldProps {
  label: string;
  /** Short guidance under the label's control; replaced by the error when there is one. */
  hint?: ReactNode;
  error?: string | null;
  /** Right side of the label row, e.g. a character counter. */
  aside?: ReactNode;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}

/**
 * Label above the control (13px), hint or error below. The error is announced politely and linked
 * to the control with aria-describedby, so a screen reader reads it when the field gets focus.
 */
export function Field({ label, hint, error, aside, className, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = Boolean(error || hint);
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-13 font-medium text-ink">
          {label}
        </label>
        {aside ? <span className="text-12 text-ink-2">{aside}</span> : null}
      </div>
      {children({ id, 'aria-describedby': hasNote ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      <p id={noteId} aria-live="polite" className={cx('min-h-4 text-12', error ? 'text-bad' : 'text-ink-2')}>
        {error ?? hint}
      </p>
    </div>
  );
}
