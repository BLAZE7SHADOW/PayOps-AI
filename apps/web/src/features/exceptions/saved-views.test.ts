import { describe, expect, it } from 'vitest';
import { filtersFromUrl, hasFilters, sameFilters, urlPatchFromFilters } from './saved-views';

describe('saved views', () => {
  it('reads filters from the URL and leaves defaults and junk out', () => {
    expect(filtersFromUrl({})).toEqual({});
    expect(filtersFromUrl({ scope: 'open', type: 'NOPE', severity: 'HIGH', q: '  PAY-1 ', assignee: 'me', overdue: 'true' })).toEqual({
      severity: 'HIGH',
      q: 'PAY-1',
      assigneeId: 'me',
      overdue: true,
    });
    expect(filtersFromUrl({ scope: 'closed', overdue: 'false' })).toEqual({ scope: 'closed' });
  });

  it('applies a view by setting its keys and clearing every other one', () => {
    expect(urlPatchFromFilters({ severity: 'CRITICAL', overdue: true })).toEqual({
      scope: undefined,
      type: undefined,
      severity: 'CRITICAL',
      q: undefined,
      assignee: undefined,
      overdue: 'true',
    });
    expect(urlPatchFromFilters({ scope: 'all', assigneeId: 'unassigned' })).toMatchObject({ scope: 'all', assignee: 'unassigned' });
  });

  it('round trips through the URL', () => {
    const view = { severity: 'HIGH', assigneeId: 'me', overdue: true } as const;
    const url = urlPatchFromFilters(view);
    expect(filtersFromUrl(url)).toEqual(view);
  });

  it('ignores an assignee that the page cannot show', () => {
    expect(urlPatchFromFilters({ assigneeId: 'usr_someone' }).assignee).toBeUndefined();
  });

  it('compares views by meaning', () => {
    expect(sameFilters({ scope: 'open', severity: 'HIGH' }, { severity: 'HIGH' })).toBe(true);
    expect(sameFilters({ severity: 'HIGH' }, { severity: 'LOW' })).toBe(false);
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ q: 'x' })).toBe(true);
  });
});
