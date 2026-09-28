/**
 * Retry helper for a genuine Postgres serialization failure (SQLSTATE `40001`), the error a
 * `SERIALIZABLE` (or `REPEATABLE READ`) transaction gets when it loses a write-write race it
 * cannot itself detect until commit. Standard Postgres guidance is to retry the whole
 * transaction from scratch; this project's own DB usage is READ COMMITTED almost everywhere; the
 * one place this project deliberately assumes it might see a `40001` is the executor's own
 * result-recording transaction (`packages/core/src/execution/executor.service.ts`), because
 * that's the specific case docs/06-phases.md Phase 5 task 6 names ("database serialization
 * conflict during execute"). `withSerializationRetry` is otherwise unopinionated: it retries only
 * `40001`, never any other error (a broken query, a constraint violation, a real outage should
 * fail immediately, not be masked by a loop), and gives up after a small fixed number of
 * attempts so a *persistent* conflict still surfaces as a real error for its caller to turn into
 * a defined state (see `nodes.ts`'s `execute` node, `ResolutionService.escalateExecutionError`).
 */

/** node-postgres attaches the raw SQLSTATE as `.code` on the thrown error (not a typed export
 * from `pg` itself, so this checks the shape rather than an `instanceof`). PGlite (local
 * dev/tests) mirrors the same `.code` field on the errors it throws. */
export function isSerializationFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '40001';
}

export interface SerializationRetryOptions {
  /** Total attempts including the first, not additional retries. Default 3. */
  attempts?: number;
  /** Delay before each retry, in ms. Default 25 -- long enough to let a colliding transaction
   * finish committing, short enough not to matter for a request in flight. */
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying it (from scratch -- `fn` must be safe to call again, e.g. a fresh
 * `db.transaction(...)`) while it keeps throwing a `40001`. Any other error, or a `40001` on the
 * last allowed attempt, propagates to the caller unchanged.
 */
export async function withSerializationRetry<T>(fn: () => Promise<T>, opts: SerializationRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 25;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSerializationFailure(err) || attempt === attempts) throw err;
      await sleep(delayMs);
    }
  }
  // Unreachable (the loop always returns or throws), kept only so TypeScript sees every path end.
  throw lastErr;
}
