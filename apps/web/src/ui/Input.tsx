import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from './cx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        'transition-color h-10 min-w-0 rounded-md border border-control bg-surface px-3 text-14 text-ink max-md:h-11',
        'hover:border-ink-2 focus:border-accent aria-[invalid=true]:border-bad',
        mono && 'tabular font-mono',
        className,
      )}
      {...rest}
    />
  );
});
