import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger, ServerEnv } from '@payops/core';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { requestId } from './middleware/request-id';
import { buildRouter, type RouteDeps } from './routes';

export interface AppDeps extends RouteDeps {
  env: ServerEnv;
  log: Logger;
}

/** Express app factory. Kept free of listen() so tests can mount it with supertest. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger: deps.log,
      genReqId: (req) => (req as express.Request).requestId,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: deps.env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', buildRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.log));
  return app;
}
