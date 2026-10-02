import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone, scrubPiiText } from './mask';

describe('field maskers', () => {
  it('keeps only the first letter of the email name', () => {
    expect(maskEmail('rahul@gmail.com')).toBe('r****@gmail.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('keeps only the last four phone digits', () => {
    expect(maskPhone('+91 98765 54321')).toBe('+91 ******4321');
  });
});

describe('scrubPiiText', () => {
  it('removes emails', () => {
    const out = scrubPiiText('Please write to rahul.k+pay@proton.me about my refund');
    expect(out).toBe('Please write to [email removed] about my refund');
  });

  it('removes Indian mobile numbers in common spellings', () => {
    for (const phone of ['9876554321', '+91 98765 54321', '+919876554321', '98765-54321', '91-9876554321']) {
      expect(scrubPiiText(`call me on ${phone} today`)).toBe('call me on [phone removed] today');
    }
  });

  it('removes card-length digit runs, with or without spaces', () => {
    expect(scrubPiiText('card 4111 1111 1111 1111 was charged')).toBe('card [number removed] was charged');
    expect(scrubPiiText('acct 123456789012345')).toBe('acct [number removed]');
  });

  it('keeps ids, amounts and dates that models legitimately need', () => {
    const text = 'pay_8291 for 1250000 paise captured at 2026-09-28T12:00:00Z, order ord_100234, status CAPTURED';
    expect(scrubPiiText(text)).toBe(text);
  });

  it('is a no-op on text without PII and safe to apply twice', () => {
    const once = scrubPiiText('mail a@b.io or 9876554321');
    expect(scrubPiiText(once)).toBe(once);
    expect(scrubPiiText('')).toBe('');
  });
});
