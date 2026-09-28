import { useMemo } from 'react';

/**
 * Resolve CSS token values for libraries that write SVG attributes (Recharts),
 * where var(--token) is not reliably supported. tokens.css stays the single source.
 */
export function useTokenValues<K extends string>(names: readonly K[]): Record<K, string> {
  const key = names.join(',');
  return useMemo(() => {
    const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    return Object.fromEntries(key.split(',').map((n) => [n, style?.getPropertyValue(`--${n}`).trim() ?? ''])) as Record<K, string>;
  }, [key]);
}
