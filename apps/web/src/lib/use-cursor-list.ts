import { keepPreviousData, useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Page } from '@payops/shared';
import { api, toQueryString } from './api';

type Params = Record<string, string | number | boolean | undefined>;

/** Keyset-paginated list: flattens pages and exposes total from the first page. */
export function useCursorList<T>(queryKey: QueryKey, path: string, params: Params, limit = 25) {
  const q = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<T>>(`${path}${toQueryString({ ...params, limit, cursor: pageParam ?? undefined })}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return { ...q, items, total: q.data?.pages[0]?.total };
}
