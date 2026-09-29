import { describe, expect, it } from 'vitest';
import { SLA_HOURS, dueAtFor, isOverdue } from './sla';

const opened = new Date('2026-09-29T10:00:00.000Z');

describe('dueAtFor', () => {
  it('adds the severity window to the opened time', () => {
    expect(dueAtFor('CRITICAL', opened).toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(dueAtFor('HIGH', opened).toISOString()).toBe('2026-09-29T18:00:00.000Z');
    expect(dueAtFor('MEDIUM', opened).toISOString()).toBe('2026-09-30T10:00:00.000Z');
    expect(dueAtFor('LOW', opened).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('gives more urgent severities a shorter window', () => {
    expect(SLA_HOURS.CRITICAL).toBeLessThan(SLA_HOURS.HIGH);
    expect(SLA_HOURS.HIGH).toBeLessThan(SLA_HOURS.MEDIUM);
    expect(SLA_HOURS.MEDIUM).toBeLessThan(SLA_HOURS.LOW);
  });
});

describe('isOverdue', () => {
  const due = new Date('2026-09-29T14:00:00.000Z');
  it('is false before and exactly at the due time', () => {
    expect(isOverdue(due, true, new Date('2026-09-29T13:59:59.000Z'))).toBe(false);
    expect(isOverdue(due, true, due)).toBe(false);
  });
  it('is true after the due time while the case is open', () => {
    expect(isOverdue(due, true, new Date('2026-09-29T14:00:01.000Z'))).toBe(true);
  });
  it('is false for closed cases and cases without a due time', () => {
    expect(isOverdue(due, false, new Date('2026-09-30T00:00:00.000Z'))).toBe(false);
    expect(isOverdue(null, true, new Date('2026-09-30T00:00:00.000Z'))).toBe(false);
  });
});
