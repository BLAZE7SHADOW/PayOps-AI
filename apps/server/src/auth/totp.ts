/**
 * Time-based one-time passwords (RFC 6238) on Node's crypto, so there is no extra dependency.
 * An authenticator app and this server share a secret; both compute HMAC-SHA1 over "the number
 * of 30-second steps since 1970" and show the last 6 digits.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('Not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 random bits, the size RFC 4226 recommends for an HMAC-SHA1 key. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  digits?: number;
}

/** The code an authenticator app shows for `secret` at `nowMs`. */
export function totpCode(secret: string, nowMs: number, opts: TotpOptions = {}): string {
  return hotp(base32Decode(secret), stepAt(nowMs), opts.digits ?? 6);
}

export interface VerifyTotpInput {
  secret: string;
  code: string;
  nowMs: number;
  /** The step of the last accepted code. Anything at or before it is refused (no reuse). */
  lastUsedStep?: number | null;
  /** Steps of clock drift accepted on each side of now. */
  window?: number;
}

/** Returns the matching step number (store it as lastUsedStep), or null when the code is wrong. */
export function verifyTotp({ secret, code, nowMs, lastUsedStep, window = 1 }: VerifyTotpInput): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  const current = stepAt(nowMs);
  for (let step = current - window; step <= current + window; step += 1) {
    if (lastUsedStep != null && step <= lastUsedStep) continue;
    const expected = hotp(key, step, 6);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** RFC 4226 HOTP: HMAC-SHA1 of the counter, then "dynamic truncation" to a few decimal digits. */
function hotp(key: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}
