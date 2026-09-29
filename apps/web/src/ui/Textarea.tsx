import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx(
        'transition-color min-h-20 w-full resize-y rounded-md border border-control bg-surface px-3 py-2 text-14 text-ink',
        'hover:border-ink-2 focus:border-accent aria-[invalid=true]:border-bad',
        className,
      )}
      {...rest}
    />
  );
});
