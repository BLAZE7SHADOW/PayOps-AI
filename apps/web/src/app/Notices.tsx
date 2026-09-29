import { Cross2Icon } from '@radix-ui/react-icons';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CASE_TYPE_LABEL, formatMoney } from '@payops/shared';
import { resolutionTone } from '../lib/resolution';
import { NOTICE_TTL_MS, useRealtimeStore, type Notice } from '../lib/realtime-store';
import { Tag } from '../ui/Tag';

/** Calm bottom-right notices for realtime events. At most 3, 6s each, no animation. */
export function Notices() {
  const notices = useRealtimeStore((s) => s.notices);
  return (
    <div role="status" aria-live="polite" aria-label="Updates" className="fixed right-6 bottom-6 z-30 flex w-[440px] max-w-[calc(100vw-48px)] flex-col gap-2">
      {notices.map((n) => (
        <NoticeRow key={n.key} notice={n} />
      ))}
    </div>
  );
}

const Sep = () => <span className="text-ink-2"> · </span>;

function NoticeRow({ notice }: { notice: Notice }) {
  const dismiss = useRealtimeStore((s) => s.dismissNotice);
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.key), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [notice.key, dismiss]);
  const close = () => dismiss(notice.key);
  const caseLink = (id: string, displayId: string) => (
    <Link to={`/cases/${id}`} className="link font-mono" onClick={close}>
      {displayId}
    </Link>
  );

  let body: ReactNode;
  switch (notice.kind) {
    case 'created':
    case 'updated':
      body = (
        <>
          {notice.kind === 'created' ? 'New case ' : 'Updated '}
          {caseLink(notice.item.id, notice.item.displayId)}
          <Sep />
          <span className="text-ink-2">{CASE_TYPE_LABEL[notice.item.type]}</span>
          <Sep />
          <span className="tabular font-mono">{formatMoney(notice.item.amountMinor)}</span>
        </>
      );
      break;
    case 'approval':
      body = (
        <>
          <Link to={`/approvals?approval=${notice.item.id}`} className="link" onClick={close}>
            Approval needed
          </Link>
          <Sep />
          {caseLink(notice.item.case.id, notice.item.case.displayId)}
          <Sep />
          <span className="text-ink-2">{notice.item.actionsSummary}</span>
          <Sep />
          <span className="font-mono text-12">{notice.item.tier}</span>
        </>
      );
      break;
    case 'verified':
      body = (
        <span className="inline-flex items-center gap-1.5">
          {caseLink(notice.caseId, notice.displayId)}
          <span>verified</span>
          <span className="text-ink-2">·</span>
          <Tag tone={resolutionTone.verdict(notice.verdict)}>{notice.verdict}</Tag>
        </span>
      );
      break;
    case 'local':
      body = (
        <>
          {notice.text}
          {notice.caseId && notice.displayId ? <> {caseLink(notice.caseId, notice.displayId)}</> : null}
        </>
      );
      break;
  }

  return (
    <div className="flex items-center gap-2 rounded-sm border border-rule bg-surface py-2 pr-1 pl-3 text-13 shadow-pop">
      <p className="min-w-0 flex-1 truncate text-ink">{body}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="transition-color grid size-7 shrink-0 place-items-center rounded-xs text-ink-2 hover:bg-surface-sunk hover:text-ink"
      >
        <Cross2Icon width={15} height={15} />
      </button>
    </div>
  );
}
