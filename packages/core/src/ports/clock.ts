export interface ClockPort {
  now(): Date;
}
export const systemClock: ClockPort = { now: () => new Date() };
