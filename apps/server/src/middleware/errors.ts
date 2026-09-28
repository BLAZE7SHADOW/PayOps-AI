import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type Logger } from '@payops/core';
import type { ApiErrorBody } from '@payops/shared';

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiErrorBody = {
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.requestId },
  };
  res.status(404).json(body);
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    let status = 500;
    let body: ApiErrorBody;

    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details, requestId: req.requestId } };
    } else if (err instanceof ZodError) {
      status = 422;
      body = {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: req.requestId,
        },
      };
    } else if (isBodyParserError(err)) {
      status = 400;
      body = { error: { code: 'BAD_REQUEST', message: 'Malformed JSON body', requestId: req.requestId } };
    } else {
      log.error({ err, requestId: req.requestId }, 'unhandled error');
      body = { error: { code: 'INTERNAL', message: 'Unexpected server error', requestId: req.requestId } };
    }
    res.status(status).json(body);
  };
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
