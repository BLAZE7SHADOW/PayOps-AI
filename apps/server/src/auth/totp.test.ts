import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, totpCode, verifyTotp } from './totp';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('base32', () => {
  it('round-trips and matches the RFC 4648 example', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const random = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(random))).toEqual(random);
  });
  it('accepts lower case and spaces, rejects other characters', () => {
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('totpCode', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    it(`matches the RFC 6238 vector at T=${seconds}`, () => {
      expect(totpCode(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
    });
  }
  it('gives six digits by default, keeping leading zeros', () => {
    expect(totpCode(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: totpCode(RFC_SECRET, now), nowMs: now })).toBe(step);
  });
  it('accepts one step of clock drift either way, not two', () => {
    const at = (offsetSteps: number) => totpCode(RFC_SECRET, now + offsetSteps * 30_000);
    expect(verifyTotp({ secret: RFC_SECRET, code: at(-1), nowMs: now })).toBe(step - 1);
    expect(verifyTotp({ secret: RFC_SECRET, code: at(1), nowMs: now })).toBe(step + 1);
    expect(verifyTotp({ secret: RFC_SECRET, code: at(-2), nowMs: now })).toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code: at(2), nowMs: now })).toBeNull();
  });
  it('refuses a step that was already used, so a code works once', () => {
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now, lastUsedStep: step - 1 })).toBe(step);
  });
  it('rejects wrong, short, long and non-numeric codes without throwing', () => {
    for (const code of ['000000', '12345', '1234567', 'abcdef', '', ' 123456 x']) {
      expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now })).toBeNull();
    }
  });
  it('ignores spaces inside a code, as authenticator apps display "123 456"', () => {
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp({ secret: RFC_SECRET, code: `${code.slice(0, 3)} ${code.slice(3)}`, nowMs: now })).toBe(step);
  });
});

describe('enrolment helpers', () => {
  it('generates a 160-bit base32 secret, different every time', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });
  it('builds an otpauth URL authenticator apps understand', () => {
    const url = new URL(otpauthUrl({ secret: 'ABCDEFGH', account: 'ops@payops.dev', issuer: 'PayOps AI' }));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/PayOps AI:ops@payops.dev');
    expect(url.searchParams.get('secret')).toBe('ABCDEFGH');
    expect(url.searchParams.get('issuer')).toBe('PayOps AI');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
