import pino, { type Logger } from 'pino';
import type { ServerEnv } from '../config/env';

export type { Logger };

export function createLogger(env: Pick<ServerEnv, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>, name: string): Logger {
  const pretty = env.LOG_PRETTY ?? env.NODE_ENV === 'development';
  return pino({
    name,
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.apiKey'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } } : {}),
  });
}
