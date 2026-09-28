/**
 * Password hashing with Node's built-in scrypt (no native dependency).
 * Stored format: `scrypt$<salt base64>$<hash base64>`, with a random 16-byte salt per user.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LENGTH = 64;
const OPTIONS: ScryptOptions = { N: 16_384, r: 8, p: 1 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, OPTIONS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time comparison; malformed hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltB64, 'base64'));
  return timingSafeEqual(actual, expected);
}
