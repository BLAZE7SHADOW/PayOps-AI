import type { LifecycleEvent, LifecycleTone } from '@payops/shared';
import { formatDateTime, formatFullDateTime } from '../lib/format';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { cx } from './cx';

const TONE: Record<LifecycleTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-ink-3',
};

const TONE_WORD: Record<LifecycleTone, string> = { ok: 'ok', warn: 'warning', bad: 'problem', neutral: '' };

/** Merged lifecycle across systems: time, system label, title, detail. One row per event, in order. */
export function Timeline({ events }: { events: LifecycleEvent[] }) {
  if (events.length === 0) return <EmptyState message="No lifecycle events recorded." />;
  return (
    <ol aria-label="Lifecycle" className="text-13">
      {events.map((e, i) => (
        <li
          key={`${e.at}-${i}`}
          className="grid grid-cols-[112px_88px_minmax(0,1fr)] gap-x-3 border-b border-rule py-2 last:border-b-0"
        >
          <time dateTime={e.at} title={formatFullDateTime(e.at)} className="tabular pt-px font-mono text-12 text-ink-2">
            {formatDateTime(e.at)}
          </time>
          <span className="flex items-start gap-1.5 pt-px">
            <span aria-hidden="true" className={cx('mt-[5px] size-1.5 shrink-0', TONE[e.tone])} />
            <span className="font-mono text-11 font-medium tracking-[0.02em] text-ink-2">{e.system}</span>
          </span>
          <span className="min-w-0">
            <span className={cx('block', e.tone === 'bad' ? 'text-bad' : 'text-ink')}>
              {e.title}
              {TONE_WORD[e.tone] && e.tone !== 'ok' ? <span className="sr-only"> ({TONE_WORD[e.tone]})</span> : null}
            </span>
            {e.detail ? <span className="mt-0.5 block text-12 break-words text-ink-2">{e.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TimelineSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ol aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="grid grid-cols-[112px_88px_minmax(0,1fr)] gap-x-3 border-b border-rule py-2 last:border-b-0">
          <span className="flex h-5 items-center">
            <Skeleton width={96} />
          </span>
          <span className="flex h-5 items-center">
            <Skeleton width={64} />
          </span>
          <span className="flex flex-col justify-center gap-1.5 py-1">
            <Skeleton width={i % 2 ? '70%' : '55%'} />
            <Skeleton width="40%" height={10} />
          </span>
        </li>
      ))}
    </ol>
  );
}
