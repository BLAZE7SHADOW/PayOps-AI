import type { ApiErrorBody } from '@payops/shared';

/** Error thrown by every API call. `status` is 0 when the request never reached the server. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(init: { code: string; message: string; status: number; requestId?: string | null; details?: unknown }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
  }
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

type QueryValue = string | number | boolean | null | undefined;

export function toQueryString(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

/** Turn a non-2xx response into an ApiError, preferring the server's `{ error }` envelope. */
export async function parseErrorResponse(res: Response): Promise<ApiError> {
  const headerId = res.headers.get('x-request-id');
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (proxy error page, empty body). Fall through to a generic error.
  }
  if (isErrorBody(body)) {
    return new ApiError({
      code: body.error.code,
      message: body.error.message,
      status: res.status,
      requestId: body.error.requestId ?? headerId,
      details: body.error.details,
    });
  }
  return new ApiError({
    code: `HTTP_${res.status}`,
    message: res.statusText || `Request failed with status ${res.status}`,
    status: res.status,
    requestId: headerId,
  });
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts;
  // CSRF rule: every state-changing request is JSON, even with nothing to send. Browsers cannot
  // send application/json cross-site without a preflight, so the server can reject anything else.
  const sendsBody = method !== 'GET';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      signal,
      credentials: 'include',
      headers: sendsBody ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
      body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the API server.', status: 0 });
  }
  if (!res.ok) throw await parseErrorResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
