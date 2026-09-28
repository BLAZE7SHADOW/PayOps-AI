import { describe, expect, it, vi } from 'vitest';
import { isSerializationFailure, withSerializationRetry } from './retry';

function serializationError(message = 'could not serialize access due to concurrent update'): Error & { code: string } {
  return Object.assign(new Error(message), { code: '40001' });
}

describe('isSerializationFailure', () => {
  it('recognizes a Postgres/PGlite 40001 error', () => {
    expect(isSerializationFailure(serializationError())).toBe(true);
  });

  it('rejects an unrelated Postgres error code', () => {
    expect(isSerializationFailure(Object.assign(new Error('unique violation'), { code: '23505' }))).toBe(false);
  });

  it('rejects a plain Error with no code at all', () => {
    expect(isSerializationFailure(new Error('boom'))).toBe(false);
  });

  it('rejects non-object values without throwing', () => {
    expect(isSerializationFailure('boom')).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});

describe('withSerializationRetry', () => {
  it('returns the result on the first try when nothing throws', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withSerializationRetry(fn, { delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 40001 and succeeds once the conflict clears', async () => {
    const fn = vi.fn().mockRejectedValueOnce(serializationError()).mockResolvedValueOnce('ok');
    await expect(withSerializationRetry(fn, { delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up and rethrows after exhausting its attempts on a persistent conflict', async () => {
    const err = serializationError();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withSerializationRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries a non-serialization error, even once', async () => {
    const err = Object.assign(new Error('constraint violated'), { code: '23505' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withSerializationRetry(fn, { delayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects a custom attempts count', async () => {
    const fn = vi.fn().mockRejectedValue(serializationError());
    await expect(withSerializationRetry(fn, { attempts: 1, delayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
