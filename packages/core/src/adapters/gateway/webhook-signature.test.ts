import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookBody, verifyWebhookSignature } from './webhook-signature';

const secret = 'whsec_test_secret';
const body = '{"event":"payment.captured","payload":{"payment":{"id":"pay_1","amount":50000}}}';

describe('webhook signature', () => {
  it('signs with HMAC-SHA256 over the raw body, hex encoded (the Razorpay scheme)', () => {
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(signWebhookBody(secret, body)).toBe(expected);
  });

  it('accepts a correct signature', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: signWebhookBody(secret, body) })).toBe(true);
  });

  it('accepts a Buffer body the same as a string body', () => {
    const signature = signWebhookBody(secret, body);
    expect(verifyWebhookSignature({ secret, rawBody: Buffer.from(body, 'utf8'), signature })).toBe(true);
  });

  it('rejects a body changed by one character', () => {
    const signature = signWebhookBody(secret, body);
    expect(verifyWebhookSignature({ secret, rawBody: body.replace('50000', '50001'), signature })).toBe(false);
  });

  it('rejects re-serialised JSON, because the signature covers the raw bytes', () => {
    const signature = signWebhookBody(secret, body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature({ secret, rawBody: reserialised, signature })).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: signWebhookBody('other', body) })).toBe(false);
  });

  it('rejects missing, empty, wrong-length and non-hex signatures without throwing', () => {
    for (const signature of [undefined, null, '', 'abc', 'z'.repeat(64), signWebhookBody(secret, body) + '00']) {
      expect(verifyWebhookSignature({ secret, rawBody: body, signature })).toBe(false);
    }
  });

  it('is case-insensitive about hex digits', () => {
    const signature = signWebhookBody(secret, body).toUpperCase();
    expect(verifyWebhookSignature({ secret, rawBody: body, signature })).toBe(true);
  });

  it('refuses an empty secret instead of signing with it', () => {
    expect(() => signWebhookBody('', body)).toThrow();
    expect(verifyWebhookSignature({ secret: '', rawBody: body, signature: 'a'.repeat(64) })).toBe(false);
  });
});
