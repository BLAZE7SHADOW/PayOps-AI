import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-solid';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface border-accent hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'bg-surface text-ink border-control hover:bg-surface-sunk active:bg-surface-sunk',
  quiet: 'bg-transparent text-accent border-transparent hover:bg-accent-weak active:bg-accent-weak',
  danger: 'bg-surface text-bad border-bad hover:bg-bad-weak active:bg-bad-weak',
  'danger-solid': 'bg-bad text-surface border-bad hover:bg-[color-mix(in_srgb,var(--bad)_85%,var(--ink))]',
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
        'transition-color inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap',
        'disabled:border-rule-strong disabled:bg-surface-sunk disabled:text-ink-2 disabled:hover:bg-surface-sunk',
        size === 'md' ? 'h-10 px-4 text-14 max-md:h-11' : 'h-8 px-3 text-13',
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
