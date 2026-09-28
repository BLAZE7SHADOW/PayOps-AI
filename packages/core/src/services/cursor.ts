import { AppError } from '../errors';

/** Opaque keyset cursors: base64url JSON of the last row's sort key. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined, isValid: (v: unknown) => v is T): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (isValid(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new AppError('BAD_REQUEST', 'Invalid cursor');
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
