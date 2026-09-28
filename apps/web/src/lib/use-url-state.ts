import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Filters live in the URL so a view can be shared or reloaded.
 * Setting a value to undefined/'' removes the param. Updates replace history entries
 * so typing in a filter does not flood the back button.
 */
export function useUrlState<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();

  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? undefined])) as Record<K, string | undefined>;

  const set = useCallback(
    (patch: Partial<Record<K | string, string | undefined | null>>, opts: { push?: boolean } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: !opts.push },
      );
    },
    [setParams],
  );

  return [values, set] as const;
}

export function pickEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
