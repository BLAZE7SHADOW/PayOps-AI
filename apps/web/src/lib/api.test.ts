import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, parseErrorResponse, toQueryString } from './api';

const jsonResponse = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe('parseErrorResponse', () => {
  it('reads code, message and requestId from the error envelope', async () => {
    const err = await parseErrorResponse(
      jsonResponse({ error: { code: 'CASE_NOT_FOUND', message: 'No case with id case_x.', requestId: 'req_123' } }, 404),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'CASE_NOT_FOUND', message: 'No case with id case_x.', requestId: 'req_123', status: 404 });
  });

  it('falls back to the x-request-id header when the body has no requestId', async () => {
    const err = await parseErrorResponse(jsonResponse({ error: { code: 'VALIDATION_FAILED', message: 'Bad input' } }, 400, { 'x-request-id': 'req_hdr' }));
    expect(err.requestId).toBe('req_hdr');
  });

  it('handles non-JSON bodies', async () => {
    const err = await parseErrorResponse(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(err).toMatchObject({ code: 'HTTP_502', status: 502, requestId: null });
  });
});

describe('api', () => {
  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true }, 200)));
    await expect(api<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError for error responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'FORBIDDEN', message: 'No', requestId: 'req_9' } }, 403)));
    await expect(api('/api/simulator/reset', { method: 'POST' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, requestId: 'req_9' });
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/api/overview')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('sends JSON bodies', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 201));
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/simulator/scenarios', { method: 'POST', body: { scenario: 'refund_stuck', noise: 0 } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"scenario":"refund_stuck","noise":0}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });
});

describe('toQueryString', () => {
  it('drops empty values', () => {
    expect(toQueryString({ q: 'pay_1', status: undefined, mismatchOnly: false, empty: '', limit: 25 })).toBe('?q=pay_1&limit=25');
    expect(toQueryString({})).toBe('');
  });
});
