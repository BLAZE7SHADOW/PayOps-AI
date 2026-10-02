import { createHash } from 'node:crypto';

/**
 * Tamper-evident audit chain (P4 task 3, D077).
 *
 * Every audit row stores `hash = sha256(its own fields + the previous row's hash)`. Editing or
 * removing any row breaks its own hash or the next row's `prevHash`, and `verifyAuditChain`
 * reports the first place it breaks. This proves the log was changed; it cannot prevent a
 * database owner from rewriting the whole tail and recomputing every hash. The database
 * triggers stop ordinary writes, and an exported head (seq + hash) kept elsewhere closes the rest.
 */

/** `prevHash` of the very first chained row. */
export const GENESIS_HASH = '0'.repeat(64);

/** The fields that are hashed, in one fixed order. Adding a field later means a new chain version. */
export interface ChainFields {
  seq: number;
  id: string;
  at: Date;
  actorType: string;
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  before: unknown;
  after: unknown;
  runId: string | null;
  caseId: string | null;
  prevHash: string;
}

export interface ChainRow extends ChainFields {
  hash: string;
}

/** JSON with object keys sorted at every depth. Postgres jsonb does not keep key order, so plain JSON.stringify would not round-trip. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeAuditHash(f: ChainFields): string {
  const payload = canonicalJson([
    f.seq,
    f.id,
    f.at.toISOString(),
    f.actorType,
    f.actorId,
    f.actorName,
    f.action,
    f.entityType,
    f.entityId,
    f.summary,
    f.before,
    f.after,
    f.runId,
    f.caseId,
    f.prevHash,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export type ChainFailure = 'HASH_MISMATCH' | 'PREV_MISMATCH' | 'SEQ_GAP' | 'TRUNCATED';

export type ChainVerdict =
  | { ok: true; checked: number }
  | { ok: false; checked: number; seq: number | null; id: string | null; reason: ChainFailure };

export interface VerifyOptions {
  /** Rows given start after this link (for verifying a page or a suffix). Default: the chain starts at genesis. */
  startAfter?: { seq: number; hash: string };
  /** A head recorded earlier (from an export). Fails if the chain now ends before it. */
  expectedHead?: { seq: number; hash: string };
}

/** Rows must be ordered by ascending seq. Stops at the first broken row. */
export function verifyAuditChain(rows: readonly ChainRow[], opts: VerifyOptions = {}): ChainVerdict {
  let prevSeq = opts.startAfter?.seq ?? 0;
  let prevHash = opts.startAfter?.hash ?? GENESIS_HASH;
  let checked = 0;
  for (const row of rows) {
    const bad = (reason: ChainFailure): ChainVerdict => ({ ok: false, checked, seq: row.seq, id: row.id, reason });
    if (row.seq !== prevSeq + 1) return bad('SEQ_GAP');
    if (row.prevHash !== prevHash) return bad('PREV_MISMATCH');
    if (computeAuditHash(row) !== row.hash) return bad('HASH_MISMATCH');
    prevSeq = row.seq;
    prevHash = row.hash;
    checked++;
  }
  const head = opts.expectedHead;
  if (head && (prevSeq < head.seq || (prevSeq === head.seq && prevHash !== head.hash))) {
    return { ok: false, checked, seq: null, id: null, reason: 'TRUNCATED' };
  }
  return { ok: true, checked };
}
