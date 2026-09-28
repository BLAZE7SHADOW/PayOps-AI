import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { OPS_EVENTS, RUN_EVENTS, type RunEventEnvelope, type ApprovalItem, type CaseDetail, type CaseListItem, type Page, type ResolutionItem } from '@payops/shared';
import { qk } from './query-keys';
import { useRealtimeStore } from './realtime-store';

export type CaseEventHandler = (event: 'created' | 'updated', item: CaseListItem) => void;
export type ApprovalEventHandler = (event: 'requested' | 'resolved', item: ApprovalItem) => void;
export type ResolutionEventHandler = (item: ResolutionItem) => void;

/** Minimal surface we need from a socket, so the dev mock can stand in for socket.io. */
export interface RealtimeSource {
  onStatus(cb: (s: 'live' | 'reconnecting') => void): void;
  onCase(cb: CaseEventHandler): void;
  onApproval(cb: ApprovalEventHandler): void;
  onResolution(cb: ResolutionEventHandler): void;
  onRun(cb: (event: RunEventEnvelope) => void): void;
  joinCase(caseId: string): void;
  leaveCase(caseId: string): void;
  close(): void;
}

function socketIoSource(): RealtimeSource {
  // Same origin; Vite proxies /socket.io to the API server in development. The handshake carries
  // the session cookie, so this connects only after sign-in (the shell mounts behind the guard).
  const socket: Socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  const rooms = new Set<string>();
  return {
    onStatus(cb) {
      socket.on('connect', () => {
        // Rejoin case rooms after a reconnect; the server forgets them with the old socket.
        for (const id of rooms) socket.emit('case:join', id);
        cb('live');
      });
      socket.on('disconnect', () => cb('reconnecting'));
      socket.on('connect_error', () => cb('reconnecting'));
    },
    onCase(cb) {
      socket.on(OPS_EVENTS.caseCreated, (item: CaseListItem) => cb('created', item));
      socket.on(OPS_EVENTS.caseUpdated, (item: CaseListItem) => cb('updated', item));
    },
    onApproval(cb) {
      socket.on(OPS_EVENTS.approvalRequested, (item: ApprovalItem | RunEventEnvelope) => { if ('case' in item) cb('requested', item); });
      socket.on(OPS_EVENTS.approvalResolved, (item: ApprovalItem | RunEventEnvelope) => { if ('case' in item) cb('resolved', item); });
    },
    onResolution(cb) {
      socket.on(OPS_EVENTS.resolutionUpdated, (item: ResolutionItem) => cb(item));
    },
    onRun(cb) {
      for (const name of RUN_EVENTS) socket.on(name, (event: RunEventEnvelope | ApprovalItem) => {
        if ('runId' in event && 'seq' in event) cb(event);
      });
    },
    joinCase(caseId) {
      rooms.add(caseId);
      if (socket.connected) socket.emit('case:join', caseId);
    },
    leaveCase(caseId) {
      rooms.delete(caseId);
      if (socket.connected) socket.emit('case:leave', caseId);
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

// The one live source for the signed-in shell. Case pages join rooms through it.
let current: RealtimeSource | null = null;
const wantedRooms = new Map<string, number>();

/** Display id for a case we have cached, so a resolution notice can say "PAY-0042". */
function cachedDisplayId(qc: QueryClient, caseId: string): string | null {
  const detail = qc.getQueryData<CaseDetail>(qk.cases.detail(caseId));
  if (detail) return detail.displayId;
  for (const [, data] of qc.getQueriesData<{ pages: Page<CaseListItem>[] }>({ queryKey: qk.cases.all })) {
    const hit = data?.pages?.flatMap((p) => p.items).find((c) => c.id === caseId);
    if (hit) return hit.displayId;
  }
  return null;
}

const invalidateAll = (qc: QueryClient, keys: ReadonlyArray<readonly unknown[]>) => {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
};

/** Connects once per signed-in shell; invalidates queries and raises notices on ops events. */
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
      current = s;
      for (const id of wantedRooms.keys()) s.joinCase(id);
      s.onStatus((status) => {
        setConnection(status);
        // Authoritative reads recover steps missed while disconnected, including paused runs.
        if (status === 'live') invalidateAll(qc, [qk.runs.all, qk.cases.all, qk.approvals.all, qk.overview()]);
      });
      s.onRun((event) => {
        invalidateAll(qc, [qk.runs.list(event.caseId), qk.runs.steps(event.runId), qk.cases.detail(event.caseId), qk.overview()]);
      });
      s.onCase((kind, item) => {
        invalidateAll(qc, [qk.cases.all, qk.overview(), qk.payments.all]);
        pushNotice({ kind, item, subject: `case:${item.id}` });
      });
      s.onApproval((kind, item) => {
        invalidateAll(qc, [qk.approvals.all, qk.overview(), qk.cases.detail(item.case.id)]);
        if (kind === 'requested') pushNotice({ kind: 'approval', item, subject: `approval:${item.id}` });
      });
      s.onResolution((item) => {
        invalidateAll(qc, [qk.cases.detail(item.caseId), qk.approvals.all, qk.overview()]);
        if (item.validation) {
          const displayId = cachedDisplayId(qc, item.caseId) ?? item.caseId;
          pushNotice({ kind: 'verified', caseId: item.caseId, displayId, verdict: item.validation.verdict, subject: `case:${item.caseId}` });
        }
      });
    });

    return () => {
      cancelled = true;
      if (current === source) current = null;
      source?.close();
      setConnection('connecting');
    };
  }, [qc]);
}

/** Join the case room while a case page is mounted, so per-case events reach this client. */
export function useCaseRoom(caseId: string): void {
  useEffect(() => {
    if (!caseId) return;
    wantedRooms.set(caseId, (wantedRooms.get(caseId) ?? 0) + 1);
    current?.joinCase(caseId);
    return () => {
      const n = (wantedRooms.get(caseId) ?? 1) - 1;
      if (n > 0) wantedRooms.set(caseId, n);
      else {
        wantedRooms.delete(caseId);
        current?.leaveCase(caseId);
      }
    };
  }, [caseId]);
}
