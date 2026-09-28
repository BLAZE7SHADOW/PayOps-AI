import { Cross2Icon } from '@radix-ui/react-icons';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { CASE_TYPE_LABEL, formatMoney } from '@payops/shared';
import { NOTICE_TTL_MS, useRealtimeStore, type Notice } from '../lib/realtime-store';

/** Calm bottom-right notices for realtime case events. At most 3, 6s each, no animation. */
export function Notices() {
  const notices = useRealtimeStore((s) => s.notices);
  return (
    <div aria-live="polite" aria-label="Case updates" className="fixed right-6 bottom-6 z-30 flex w-[440px] max-w-[calc(100vw-48px)] flex-col gap-2">
      {notices.map((n) => (
        <NoticeRow key={n.key} notice={n} />
      ))}
    </div>
  );
}

function NoticeRow({ notice }: { notice: Notice }) {
  const dismiss = useRealtimeStore((s) => s.dismissNotice);
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.key), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [notice.key, dismiss]);
  const { item } = notice;
  return (
    <div className="flex items-center gap-2 rounded-sm border border-rule bg-surface py-2 pr-1 pl-3 text-13 shadow-pop">
      <p className="min-w-0 flex-1 text-ink">
        {notice.kind === 'created' ? 'New case ' : 'Updated '}
        <Link to={`/cases/${item.id}`} className="link font-mono" onClick={() => dismiss(notice.key)}>
          {item.displayId}
        </Link>
        <span className="text-ink-2">
          {' · '}
          {CASE_TYPE_LABEL[item.type]}
          {' · '}
        </span>
        <span className="tabular font-mono">{formatMoney(item.amountMinor)}</span>
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(notice.key)}
        className="transition-color grid size-7 shrink-0 place-items-center rounded-xs text-ink-2 hover:bg-surface-sunk hover:text-ink"
      >
        <Cross2Icon width={15} height={15} />
      </button>
    </div>
  );
}
