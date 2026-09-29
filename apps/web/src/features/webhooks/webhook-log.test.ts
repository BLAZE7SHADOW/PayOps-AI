import { describe, expect, it } from 'vitest';
import { nextStep } from './webhook-log';

const now = new Date('2026-09-29T10:00:00.000Z');

describe('nextStep', () => {
  it('says nothing is needed for a processed event', () => {
    expect(nextStep({ status: 'PROCESSED', nextRetryAt: null }, now)).toBe('Nothing to do');
  });
  it('says only a person can act on a dead event', () => {
    expect(nextStep({ status: 'DEAD', nextRetryAt: null }, now)).toBe('Replay it by hand');
  });
  it('shows when the next automatic retry runs', () => {
    expect(nextStep({ status: 'FAILED', nextRetryAt: '2026-09-29T10:05:00.000Z' }, now)).toBe('Retry in 5m');
  });
  it('says a retry is due once its time has passed', () => {
    expect(nextStep({ status: 'FAILED', nextRetryAt: '2026-09-29T09:59:00.000Z' }, now)).toBe('Retry is due');
  });
  it('leaves retries to the gateway when none of ours is queued', () => {
    expect(nextStep({ status: 'FAILED', nextRetryAt: null }, now)).toBe('Gateway is still retrying');
  });
});
