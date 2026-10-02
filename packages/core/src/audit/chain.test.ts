import { describe, expect, it } from 'vitest';
import { canonicalJson, computeAuditHash, GENESIS_HASH, verifyAuditChain, type ChainRow } from './chain';

function link(prev: ChainRow | null, seq: number, over: Partial<ChainRow> = {}): ChainRow {
  const base = {
    seq,
    id: `audit_${seq}`,
    at: new Date(Date.UTC(2026, 8, 30, 10, 0, seq)),
    actorType: 'USER',
    actorId: 'u1',
    actorName: 'Ananya Rao',
    action: 'case.note',
    entityType: 'case',
    entityId: 'case_1',
    summary: `event ${seq}`,
    before: null,
    after: { b: 1, a: 2 },
    runId: null,
    caseId: 'case_1',
    prevHash: prev ? prev.hash : GENESIS_HASH,
    ...over,
  } as Omit<ChainRow, 'hash'>;
  return { ...base, hash: computeAuditHash(base) };
}

const chain = (n: number): ChainRow[] => {
  const rows: ChainRow[] = [];
  for (let i = 1; i <= n; i++) rows.push(link(rows[i - 2] ?? null, i));
  return rows;
};

describe('canonicalJson', () => {
  it('sorts object keys at every depth so jsonb key order cannot change a hash', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
  });
  it('treats undefined like null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('verifyAuditChain', () => {
  it('passes an untouched chain', () => {
    expect(verifyAuditChain(chain(5))).toEqual({ ok: true, checked: 5 });
  });
  it('passes an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, checked: 0 });
  });
  it('fails when a field of a stored row is edited', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, summary: 'nothing to see here' };
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 3, reason: 'HASH_MISMATCH' });
  });
  it('fails when a nested before/after value is edited', () => {
    const rows = chain(4);
    rows[1] = { ...rows[1]!, after: { a: 3, b: 1 } };
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: 'HASH_MISMATCH' });
  });
  it('fails when a row is deleted from the middle', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 4, reason: 'SEQ_GAP' });
  });
  it('fails when the newest row is deleted only if a head is supplied', () => {
    const rows = chain(5);
    const head = rows[4]!;
    rows.pop();
    expect(verifyAuditChain(rows).ok).toBe(true);
    expect(verifyAuditChain(rows, { expectedHead: { seq: head.seq, hash: head.hash } })).toMatchObject({ ok: false, reason: 'TRUNCATED' });
  });
  it('fails when a row is rewritten together with its own hash (prev link breaks next row)', () => {
    const rows = chain(4);
    rows[1] = link(rows[0]!, 2, { summary: 'rewritten' });
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 3, reason: 'PREV_MISMATCH' });
  });
  it('fails when the first row does not start from genesis', () => {
    const rows = chain(3).slice(0);
    rows[0] = link(null, 1, { prevHash: 'abc' });
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 1, reason: 'PREV_MISMATCH' });
  });
  it('accepts a chain that starts at a later seq when told where to start', () => {
    const rows = chain(6);
    expect(verifyAuditChain(rows.slice(3), { startAfter: { seq: 3, hash: rows[2]!.hash } })).toEqual({ ok: true, checked: 3 });
  });
});
