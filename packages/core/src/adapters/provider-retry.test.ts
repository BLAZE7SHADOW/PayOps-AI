import { describe, expect, it, vi } from 'vitest';
import { choice } from '../ports/decision';
import { JevDecisionAdapter } from './decision/jev-decision.adapter';
import { transientProviderReason, withProviderRetry } from './provider-retry';

describe('provider retry', () => {
  it('retries a transient 503 twice, then returns the response', async () => {
    const call = vi.fn().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 503 }).mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    await expect(withProviderRetry('Jev', call, onRetry, sleep)).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
    expect(onRetry).toHaveBeenCalledWith({ provider: 'Jev', attempt: 1, maxAttempts: 3, delayMs: 250, reason: 'unavailable' });
  });

  it('stops after three attempts and never retries invalid requests', async () => {
    const sleep = vi.fn(async () => {});
    const transient = vi.fn(async () => { throw { status: 429 }; });
    await expect(withProviderRetry('Gemini', transient, undefined, sleep)).rejects.toEqual({ status: 429 });
    expect(transient).toHaveBeenCalledTimes(3);
    const invalid = vi.fn(async () => { throw { status: 400 }; });
    await expect(withProviderRetry('Gemini', invalid, undefined, sleep)).rejects.toEqual({ status: 400 });
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(transientProviderReason(new Error('REPLAY miss'))).toBeNull();
    expect(transientProviderReason({ name: 'APITimeoutError' })).toBe('timeout');
    expect(transientProviderReason({ name: 'APIConnectionError' })).toBe('network');
  });

  it('honors a bounded rate-limit wait', async () => {
    const call = vi.fn().mockRejectedValueOnce({ status: 429, retryAfterMs: 20_000 }).mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});
    await expect(withProviderRetry('Jev', call, undefined, sleep)).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('records Jev transport retries without stacking the SDK retries', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"unavailable"}', { status: 503 }));
    const onRetry = vi.fn();
    try {
      const adapter = new JevDecisionAdapter({ apiKey: 'test-only-key', model: 'jev-test', onRetry });
      await expect(adapter.ask({ tag: 'J2_PLAN', state: { caseType: 'TEST' }, questions: { route: choice('Which route?', { a: 'First route', b: 'Second route' }) } })).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ provider: 'Jev', step: 'J2_PLAN', reason: 'unavailable' }));
    } finally {
      fetch.mockRestore();
    }
  });
});
