import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './secret-box';

describe('secret box', () => {
  it('round-trips a secret and never stores it in the clear', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', 'key-one');
    expect(sealed.startsWith('v1$')).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, 'key-one')).toBe('JBSWY3DPEHPK3PXP');
  });
  it('uses a fresh nonce each time', () => {
    expect(sealSecret('same', 'k')).not.toBe(sealSecret('same', 'k'));
  });
  it('returns null under another key, for a tampered value and for garbage', () => {
    const sealed = sealSecret('secret', 'key-one');
    expect(openSecret(sealed, 'key-two')).toBeNull();
    const parts = sealed.split('$');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(openSecret(parts.join('$'), 'key-one')).toBeNull();
    expect(openSecret('garbage', 'key-one')).toBeNull();
    expect(openSecret('', 'key-one')).toBeNull();
  });
});
