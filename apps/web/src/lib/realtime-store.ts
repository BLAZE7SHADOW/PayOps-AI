import { create } from 'zustand';
import type { ApprovalItem, CaseListItem, ValidationVerdict } from '@payops/shared';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

/** Everything a notice can say. Each kind renders one calm line (app/Notices.tsx). */
export type NoticeBody =
  | { kind: 'created' | 'updated'; item: CaseListItem }
  | { kind: 'approval'; item: ApprovalItem }
  | { kind: 'verified'; caseId: string; displayId: string; verdict: ValidationVerdict }
  /** Confirmation of something this user just did, e.g. "Requested manager approval for PAY-0042". */
  | { kind: 'local'; text: string; caseId?: string; displayId?: string };

export type Notice = NoticeBody & {
  key: string;
  /** Notices with the same subject replace each other instead of stacking. */
  subject: string;
};

const MAX_NOTICES = 3;
export const NOTICE_TTL_MS = 6_000;

interface RealtimeState {
  connection: ConnectionState;
  notices: Notice[];
  setConnection: (c: ConnectionState) => void;
  pushNotice: (n: NoticeBody & { subject: string }) => void;
  dismissNotice: (key: string) => void;
}

let seq = 0;

/** UI-only state for the socket connection and notices. Server data stays in TanStack Query. */
export const useRealtimeStore = create<RealtimeState>((set) => ({
  connection: 'connecting',
  notices: [],
  setConnection: (connection) => set({ connection }),
  pushNotice: (n) =>
    set((s) => {
      // A plain "Updated PAY-0042" must not replace a more specific line about the same case
      // ("PAY-0042 verified · PASS"), since case.updated usually follows resolution.updated.
      const existing = s.notices.find((x) => x.subject === n.subject);
      if (n.kind === 'updated' && existing && existing.kind !== 'updated' && existing.kind !== 'created') return s;
      return { notices: [...s.notices.filter((x) => x.subject !== n.subject), { ...n, key: `${n.subject}:${++seq}` }].slice(-MAX_NOTICES) };
    }),
  dismissNotice: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
}));
