import { ApiError } from '../lib/api';
import { Button } from './Button';
import { cx } from './cx';

interface ErrorStateProps {
  /** What failed, in plain words: "Could not load payments." */
  title: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title, error, onRetry, className }: ErrorStateProps) {
  const e =
    error instanceof ApiError
      ? error
      : new ApiError({ code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : 'Unknown error', status: 0 });
  return (
    <div role="alert" className={cx('flex items-start justify-between gap-4 px-4 py-6', className)}>
      <div className="min-w-0">
        <p className="text-14 font-medium text-ink">{title}</p>
        <p className="mt-1 text-13 text-ink-2">{e.message}</p>
        <p className="tabular mt-2 font-mono text-12 text-ink-2">
          <span className="text-bad">{e.code}</span>
          {e.status ? <> · HTTP {e.status}</> : null}
          {e.requestId ? <> · request {e.requestId}</> : null}
        </p>
      </div>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
