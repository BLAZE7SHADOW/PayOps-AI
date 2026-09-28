import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface border-accent hover:bg-[color-mix(in_srgb,var(--accent)_86%,var(--ink))]',
  secondary: 'bg-surface text-ink border-rule hover:bg-surface-sunk hover:border-rule-strong',
  quiet: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-sunk hover:text-ink',
  danger: 'bg-surface text-bad border-rule hover:bg-bad-weak hover:border-bad',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'transition-color inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xs border font-medium whitespace-nowrap',
        'disabled:opacity-55 disabled:hover:bg-inherit',
        size === 'md' ? 'h-8 px-3 text-13' : 'h-7 px-2 text-12',
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
