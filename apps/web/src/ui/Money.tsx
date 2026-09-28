import { formatMoney, formatMoneyCompact } from '@payops/shared';
import { cx } from './cx';

interface MoneyProps {
  minor: number;
  compact?: boolean;
  className?: string;
}

/** Amount in rupees with Indian grouping. Right alignment comes from the containing cell. */
export function Money({ minor, compact, className }: MoneyProps) {
  const full = formatMoney(minor);
  return (
    <span className={cx('tabular font-mono whitespace-nowrap', className)} title={compact ? full : undefined}>
      {compact ? formatMoneyCompact(minor) : full}
    </span>
  );
}
