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
        'transition-color min-h-16 w-full resize-y rounded-xs border border-rule bg-surface px-2 py-1.5 text-13 text-ink',
        'hover:border-rule-strong focus:border-rule-strong aria-[invalid=true]:border-bad',
        className,
      )}
      {...rest}
    />
  );
});
