import { describe, expect, it } from 'vitest';
import { csvCell, csvLine } from './csv';

describe('csvCell', () => {
  it('leaves plain text alone', () => expect(csvCell('Case opened')).toBe('Case opened'));
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });
  it('defuses formulas', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+91 98000')).toBe("'+91 98000");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
  it('writes objects as JSON and null as empty', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(7)).toBe('7');
  });
});

describe('csvLine', () => {
  it('ends with CRLF', () => expect(csvLine(['a', 'b'])).toBe('a,b\r\n'));
});
