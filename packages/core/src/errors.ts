/** Typed application errors. The API error middleware maps these to HTTP responses. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what: string, id: string) => new AppError('NOT_FOUND', `${what} ${id} not found`);
