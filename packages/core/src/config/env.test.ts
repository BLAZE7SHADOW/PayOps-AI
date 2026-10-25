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

  it('runs the TypeScript agents unless the Python service is chosen (D085)', () => {
    const env = loadServerEnv({ JWT_SECRET: '' });
    expect(env.AGENT_RUNTIME).toBe('ts');
    expect(env.AGENT_INTERNAL_SECRET).toBeUndefined();
    expect(loadServerEnv({ JWT_SECRET: '', AGENT_RUNTIME: 'python' }).AGENT_RUNTIME).toBe('python');
    expect(() => loadServerEnv({ JWT_SECRET: '', AGENT_RUNTIME: 'java' })).toThrow(/AGENT_RUNTIME/);
  });

  it('needs the shared secret and a service URL to use the Python runtime', () => {
    expect(() => loadServerEnv({ JWT_SECRET: '', AGENT_RUNTIME: 'python' })).not.toThrow();
    expect(() => loadServerEnv({ JWT_SECRET: '', AGENT_INTERNAL_SECRET: 'short' })).toThrow(/AGENT_INTERNAL_SECRET/);
    expect(loadServerEnv({ JWT_SECRET: '' }).AGENT_SERVICE_URL).toBe('http://127.0.0.1:8100');
  });
});
