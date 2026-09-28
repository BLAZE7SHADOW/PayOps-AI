import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Server-side configuration shared by api and worker.
 * Values come from process.env; the repo-root `.env` is loaded if present (never overriding
 * variables already set by the host). Secrets are never logged: use `describeEnv()` for logs.
 */

let loaded = false;
function loadDotEnvOnce(): void {
  if (loaded) return;
  loaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      // Node 22 built-in; does not override variables that are already set.
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@127.0.0.1:54329/postgres'),
  JWT_SECRET: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool.optional(),

  AI_MODE: z.enum(['LIVE', 'RECORD', 'REPLAY']).default('REPLAY'),
  AI_PROVIDER: z.enum(['gemini']).default('gemini'),
  AI_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_API_KEY: z.string().optional(),
  TYPESAFE_JEV_API_KEY: z.string().optional(),
  JEV_MODEL: z.string().default('jev-1.13'),

  GATEWAY_ADAPTER: z.enum(['simulator', 'razorpay']).default('simulator'),
  /** Background reconciliation sweep interval. 0 disables it. */
  RECONCILE_SWEEP_MS: z.coerce.number().int().min(0).default(60_000),
  /** Demo convenience: lets OPS use the simulator (ADMIN-only otherwise). */
  DEMO_MODE: bool.default(true),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

export function loadServerEnv(overrides: Partial<Record<keyof ServerEnv, string>> = {}): ServerEnv {
  if (cached && Object.keys(overrides).length === 0) return cached;
  loadDotEnvOnce();
  const parsed = ServerEnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
  }
  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

/** Safe summary for startup logs: shows which secrets are present, never their values. */
export function describeEnv(env: ServerEnv): Record<string, string | number | boolean> {
  return {
    NODE_ENV: env.NODE_ENV,
    AI_MODE: env.AI_MODE,
    AI_PROVIDER: env.AI_PROVIDER,
    AI_MODEL: env.AI_MODEL,
    JEV_MODEL: env.JEV_MODEL,
    GATEWAY_ADAPTER: env.GATEWAY_ADAPTER,
    geminiKey: env.GEMINI_API_KEY ? 'set' : 'missing',
    jevKey: env.TYPESAFE_JEV_API_KEY ? 'set' : 'missing',
    jwtSecret: env.JWT_SECRET ? 'set' : 'dev-default',
    database: redactUri(env.DATABASE_URL),
  };
}

function redactUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '(unparseable)';
  }
}
