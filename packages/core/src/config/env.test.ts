import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './env';

describe('loadServerEnv', () => {
  it('treats an empty value such as `JWT_SECRET=` (as copied from .env.example) as not set', () => {
    const env = loadServerEnv({ NODE_ENV: 'development', JWT_SECRET: '' });
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('still rejects a non-empty JWT_SECRET that is too short', () => {
    expect(() => loadServerEnv({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('still requires JWT_SECRET in production', () => {
    expect(() => loadServerEnv({ NODE_ENV: 'production', JWT_SECRET: '' })).toThrow(/required in production/);
  });

  it('checks the job queue every 2 seconds by default and accepts a slower interval', () => {
    expect(loadServerEnv({ JWT_SECRET: '' }).JOB_POLL_SECONDS).toBe(2);
    expect(loadServerEnv({ JWT_SECRET: '', JOB_POLL_SECONDS: '10' }).JOB_POLL_SECONDS).toBe(10);
  });

  it('rejects a job poll interval below the 0.5 second minimum pg-boss allows', () => {
    expect(() => loadServerEnv({ JWT_SECRET: '', JOB_POLL_SECONDS: '0.1' })).toThrow(/JOB_POLL_SECONDS/);
  });
});
