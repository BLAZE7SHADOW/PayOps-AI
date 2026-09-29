import { describe, expect, it } from 'vitest';
import { dueLabel } from './time';

const now = new Date('2026-09-29T12:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const M = 60_000;
const H = 60 * M;

describe('dueLabel', () => {
  it('counts down while time remains', () => {
    expect(dueLabel(at(3 * H + 20 * M), now)).toBe('in 3h');
    expect(dueLabel(at(45 * M), now)).toBe('in 45m');
    expect(dueLabel(at(30 * H), now)).toBe('in 1d');
  });
  it('counts up once late', () => {
    expect(dueLabel(at(-2 * H - 5 * M), now)).toBe('2h late');
    expect(dueLabel(at(-10 * M), now)).toBe('10m late');
    expect(dueLabel(at(-49 * H), now)).toBe('2d late');
  });
  it('says due now inside a minute either side', () => {
    expect(dueLabel(at(30_000), now)).toBe('due now');
    expect(dueLabel(at(-30_000), now)).toBe('due now');
  });
});
