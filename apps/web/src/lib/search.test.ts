import { describe, expect, it } from 'vitest';
import { searchTarget } from './search';

describe('searchTarget', () => {
  it('routes ids to the right screen', () => {
    expect(searchTarget('pay_7k2m9xq4')).toBe('/payments?q=pay_7k2m9xq4');
    expect(searchTarget(' ord_abc ')).toBe('/payments?q=ord_abc');
    expect(searchTarget('pay-0042')).toBe('/exceptions?scope=all&q=PAY-0042');
    expect(searchTarget('case_abc123')).toBe('/cases/case_abc123');
    expect(searchTarget('   ')).toBeNull();
  });
});
