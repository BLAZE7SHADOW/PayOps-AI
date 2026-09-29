import { describe, expect, it } from 'vitest';
import { WEBHOOK_MAX_ATTEMPTS, isWebhookSuccess, webhookRetryDelaySeconds } from './webhook-retry';

describe('webhookRetryDelaySeconds', () => {
  it('backs off after each failed attempt', () => {
    expect([1, 2, 3, 4].map(webhookRetryDelaySeconds)).toEqual([60, 300, 1800, 7200]);
  });
  it('gives up once the attempts are used', () => {
    expect(webhookRetryDelaySeconds(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
    expect(webhookRetryDelaySeconds(WEBHOOK_MAX_ATTEMPTS + 3)).toBeNull();
  });
  it('has nothing to schedule before the first attempt', () => {
    expect(webhookRetryDelaySeconds(0)).toBeNull();
  });
});

describe('isWebhookSuccess', () => {
  it('accepts 2xx only', () => {
    expect([200, 204].every(isWebhookSuccess)).toBe(true);
    expect([null, 409, 500, 302].some(isWebhookSuccess)).toBe(false);
  });
});
