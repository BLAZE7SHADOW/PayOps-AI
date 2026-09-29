/**
 * Webhook signature check shared by every gateway adapter. Razorpay and most other gateways sign
 * the RAW request body with HMAC-SHA256 and a shared secret, and send the hex digest in a header.
 * An adapter only needs to pass the raw bytes and the header value here.
 *
 * Two things matter and are easy to get wrong:
 *  - the signature covers the exact bytes received, so verify before parsing the JSON;
 *  - compare in constant time, so response timing does not leak how many characters matched.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhookBody(secret: string, rawBody: string | Buffer): string {
  if (secret.length === 0) throw new Error('A webhook secret is required to sign a body');
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export interface VerifyWebhookInput {
  secret: string;
  rawBody: string | Buffer;
  /** The signature header exactly as received. Missing or malformed values fail the check. */
  signature: string | null | undefined;
}

export function verifyWebhookSignature({ secret, rawBody, signature }: VerifyWebhookInput): boolean {
  if (secret.length === 0 || !signature) return false;
  const expected = signWebhookBody(secret, rawBody);
  // A digest is exactly 64 hex characters; anything else cannot match, and timingSafeEqual
  // throws on buffers of different lengths, so reject those first.
  if (signature.length !== expected.length || !/^[0-9a-f]+$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
