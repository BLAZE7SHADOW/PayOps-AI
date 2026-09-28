import type { ClockPort } from '../ports/clock';

export function fixedClock(iso: string): ClockPort & { advance(ms: number): void; set(iso: string): void } {
  let now = new Date(iso).getTime();
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
    set: (next) => {
      now = new Date(next).getTime();
    },
  };
}
