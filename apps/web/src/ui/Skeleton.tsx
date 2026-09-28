import type { CSSProperties } from 'react';
import { cx } from './cx';

interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: number;
  className?: string;
}

/** Static placeholder bar. No shimmer: loading should feel as calm as the loaded page. */
export function Skeleton({ width = '100%', height = 12, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('block rounded-xs bg-surface-sunk', className)}
      style={{ width, height }}
    />
  );
}
