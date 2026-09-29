/**
 * Encrypts small secrets (the TOTP seed) before they go into the database, so a copy of the
 * table alone does not let anyone generate codes. AES-256-GCM: the auth tag makes any change
 * to the stored text fail to open. The key is derived from the server's signing secret.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFrom = (secret: string): Buffer => createHash('sha256').update(`payops-secret-box|${secret}`).digest();

export function sealSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), data.toString('base64'), cipher.getAuthTag().toString('base64')].join('$');
}

/** The original text, or null when the key is wrong, the value was changed, or it is not ours. */
export function openSecret(sealed: string, secret: string): string | null {
  const [version, iv, data, tag] = sealed.split('$');
  if (version !== 'v1' || !iv || !data || !tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
