/** A bounded retry for transient provider outages. REPLAY never uses this path. */
export interface ProviderRetryNotice {
  provider: 'Gemini' | 'Jev';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: 'rate_limited' | 'unavailable' | 'timeout' | 'network';
  step?: string;
}

export type ProviderRetrySink = (notice: ProviderRetryNotice) => Promise<void> | void;

function errorFields(error: unknown): { status?: number; code?: string; name?: string; retryAfterMs?: number } {
  if (!error || typeof error !== 'object') return {};
  const value = error as Record<string, unknown>;
  const status = value.status ?? value.statusCode ?? (value.response && typeof value.response === 'object' ? (value.response as Record<string, unknown>).status : undefined);
  return {
    status: typeof status === 'number' ? status : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    retryAfterMs: typeof value.retryAfterMs === 'number' ? value.retryAfterMs : undefined,
  };
}

export function transientProviderReason(error: unknown): ProviderRetryNotice['reason'] | null {
  const { status, code, name } = errorFields(error);
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504 || name === 'AbortError' || name === 'TimeoutError' || name === 'APITimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (status && status >= 500 && status < 600) return 'unavailable';
  if (name === 'APIConnectionError' || (code && ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code))) return 'network';
  return null;
}

export async function withProviderRetry<T>(
  provider: ProviderRetryNotice['provider'],
  call: () => Promise<T>,
  onRetry?: ProviderRetrySink,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const reason = transientProviderReason(error);
      if (!reason || attempt >= maxAttempts) throw error;
      const retryAfterMs = errorFields(error).retryAfterMs;
      const delayMs = reason === 'rate_limited' && retryAfterMs !== undefined
        ? Math.min(5_000, Math.max(0, retryAfterMs)) : 250 * 2 ** (attempt - 1);
      await onRetry?.({ provider, attempt, maxAttempts, delayMs, reason });
      await sleep(delayMs);
    }
  }
}
