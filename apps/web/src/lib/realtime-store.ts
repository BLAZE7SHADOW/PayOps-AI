import { create } from 'zustand';
import type { CaseListItem } from '@payops/shared';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface Notice {
  key: string;
  kind: 'created' | 'updated';
  item: CaseListItem;
}

const MAX_NOTICES = 3;
export const NOTICE_TTL_MS = 6_000;

interface RealtimeState {
  connection: ConnectionState;
  notices: Notice[];
  setConnection: (c: ConnectionState) => void;
  pushNotice: (n: Notice) => void;
  dismissNotice: (key: string) => void;
}

/** UI-only state for the socket connection and case notices. Server data stays in TanStack Query. */
export const useRealtimeStore = create<RealtimeState>((set) => ({
  connection: 'connecting',
  notices: [],
  setConnection: (connection) => set({ connection }),
  pushNotice: (n) =>
    set((s) => ({ notices: [...s.notices.filter((x) => x.item.id !== n.item.id), n].slice(-MAX_NOTICES) })),
  dismissNotice: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
}));
