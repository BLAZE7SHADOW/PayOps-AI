/** DEV-ONLY stand-in for the socket connection when VITE_MOCK_API=1. */
import type { RealtimeSource } from '../lib/socket';
import { onMockCase } from './server';

export function mockRealtimeSource(): RealtimeSource {
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    onStatus(cb) {
      timer = setTimeout(() => cb('live'), 300);
    },
    onCase(cb) {
      off = onMockCase(cb);
    },
    close() {
      off?.();
      if (timer) clearTimeout(timer);
    },
  };
}
