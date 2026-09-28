import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Role } from '@payops/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      user?: { id: string; email: string; name: string; role: Role };
    }
  }
}

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

/** Propagates or creates `x-request-id` so logs, errors and the UI share one id. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && VALID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}
