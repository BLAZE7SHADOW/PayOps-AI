import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { OPS_EVENTS, type CaseListItem } from '@payops/shared';
import { qk } from './query-keys';
import { useRealtimeStore } from './realtime-store';

export type CaseEventHandler = (event: 'created' | 'updated', item: CaseListItem) => void;

/** Minimal surface we need from a socket, so the dev mock can stand in for socket.io. */
export interface RealtimeSource {
  onStatus(cb: (s: 'live' | 'reconnecting') => void): void;
  onCase(cb: CaseEventHandler): void;
  close(): void;
}

function socketIoSource(): RealtimeSource {
  // Same origin; Vite proxies /socket.io to the API server in development.
  const socket: Socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  return {
    onStatus(cb) {
      socket.on('connect', () => cb('live'));
      socket.on('disconnect', () => cb('reconnecting'));
      socket.on('connect_error', () => cb('reconnecting'));
    },
    onCase(cb) {
      socket.on(OPS_EVENTS.caseCreated, (item: CaseListItem) => cb('created', item));
      socket.on(OPS_EVENTS.caseUpdated, (item: CaseListItem) => cb('updated', item));
    },
    close: () => socket.close(),
  };
}

async function createSource(): Promise<RealtimeSource> {
  // DEV guard makes the whole mock branch (and its dynamic import) disappear from production builds.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { mockRealtimeSource } = await import('../mocks/realtime');
    return mockRealtimeSource();
  }
  return socketIoSource();
}

/** Connects once for the app lifetime; invalidates queries and raises notices on case events. */
export function useRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let source: RealtimeSource | null = null;
    let cancelled = false;
    const { setConnection, pushNotice } = useRealtimeStore.getState();

    void createSource().then((s) => {
      if (cancelled) {
        s.close();
        return;
      }
      source = s;
      s.onStatus(setConnection);
      s.onCase((kind, item) => {
        void qc.invalidateQueries({ queryKey: qk.cases.all });
        void qc.invalidateQueries({ queryKey: qk.overview() });
        void qc.invalidateQueries({ queryKey: qk.payments.all });
        pushNotice({ key: `${item.id}:${Date.now()}`, kind, item });
      });
    });

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [qc]);
}
