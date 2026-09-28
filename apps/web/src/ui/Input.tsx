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
        'transition-color h-8 min-w-0 rounded-xs border border-rule bg-surface px-2 text-13 text-ink',
        'hover:border-rule-strong focus:border-rule-strong',
        mono && 'tabular font-mono',
        className,
      )}
      {...rest}
    />
  );
});
