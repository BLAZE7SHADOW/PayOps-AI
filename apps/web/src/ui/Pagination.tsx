import { Button } from './Button';

interface LoadMoreProps {
  shown: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  noun: string;
}

/** Keyset pagination footer: count on the left, "Load more" on the right. */
export function LoadMore({ shown, total, hasMore, loading, onMore, noun }: LoadMoreProps) {
  if (shown === 0) return null;
  return (
    <div className="flex h-12 items-center justify-between text-12 text-ink-2">
      <span className="tabular font-mono">
        {total !== undefined ? `${shown.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} ${noun}` : `${shown.toLocaleString('en-IN')} ${noun}`}
      </span>
      {hasMore ? (
        <Button variant="secondary" size="sm" onClick={onMore} disabled={loading}>
          {loading ? 'Loading' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
