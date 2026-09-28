import { describe, expect, it } from 'vitest';
import { caseDisplayId, newId, seededIds } from './ids';

describe('ids', () => {
  it('prefixes ids', () => {
    expect(newId('payment')).toMatch(/^pay_[0-9a-z]{14}$/);
  });
  it('is deterministic for a seed', () => {
    const a = seededIds('scenario-1');
    const b = seededIds('scenario-1');
    expect([a.next('order'), a.int(1, 100)]).toEqual([b.next('order'), b.int(1, 100)]);
  });
  it('formats case display ids', () => {
    expect(caseDisplayId('PAY', 42)).toBe('PAY-0042');
  });
});
