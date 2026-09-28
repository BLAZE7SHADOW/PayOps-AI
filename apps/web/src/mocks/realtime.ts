/** DEV-ONLY stand-in for the socket connection when VITE_MOCK_API=1. */
import type { RealtimeSource } from '../lib/socket';
import { onMockEvent, type MockEvent } from './server';

export function mockRealtimeSource(): RealtimeSource {
  const offs: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const on = (cb: (e: MockEvent) => void) => offs.push(onMockEvent(cb));
  return {
    onStatus(cb) {
      timer = setTimeout(() => cb('live'), 300);
    },
    onCase(cb) {
      on((e) => e.name === 'case' && cb(e.kind, e.item));
    },
    onApproval(cb) {
      on((e) => e.name === 'approval' && cb(e.kind, e.item));
    },
    onResolution(cb) {
      on((e) => e.name === 'resolution' && cb(e.item));
    },
    // The mock broadcasts every event to everyone, so rooms are no-ops.
    joinCase() {},
    leaveCase() {},
    close() {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    },
  };
}
