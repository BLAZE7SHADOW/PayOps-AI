import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCore, type Core } from '../container';
import { auditEvents } from '../db/schema';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';
import { sealLegacyAuditRows } from './store';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-30T09:00:00.000Z');
const actor = { actorType: 'USER', actorId: 'u1', actorName: 'Ananya Rao' } as const;

const write = (n: number, extra: Record<string, unknown> = {}) =>
  core.audit.record({ ...actor, action: 'case.note', entityType: 'case', entityId: 'case_1', summary: `note ${n}`, after: { z: n, a: 'x' }, caseId: 'case_1', ...extra });

/** Drizzle wraps driver errors as "Failed query"; the trigger's message is on `cause`. */
async function expectAppendOnly(q: Promise<unknown>): Promise<void> {
  const err = (await q.then(
    () => null,
    (e: unknown) => e,
  )) as { message?: string; cause?: { message?: string } } | null;
  expect(err, 'the statement should have been rejected').not.toBeNull();
  expect(`${err?.message} ${err?.cause?.message}`).toMatch(/append-only/);
}

/** Runs `fn` with the append-only triggers off, the way a database owner could. Always turns them back on. */
async function asOwner(fn: () => Promise<unknown>): Promise<void> {
  await t.db.execute(sql`alter table audit_events disable trigger user`);
  try {
    await fn();
  } finally {
    await t.db.execute(sql`alter table audit_events enable trigger user`);
  }
}

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('audit hash chain in the database', () => {
  it('numbers rows 1..n and links each to the one before', async () => {
    for (let i = 1; i <= 4; i++) await write(i);
    const rows = await t.db.select().from(auditEvents).orderBy(auditEvents.seq);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[0]!.prevHash).toBe('0'.repeat(64));
    expect(await core.audit.verifyChain()).toMatchObject({ ok: true, checked: 4, head: { seq: 4, hash: rows[3]!.hash } });
  });

  it('keeps one unbroken chain when writes run at the same time', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => write(i)));
    expect(await core.audit.verifyChain()).toMatchObject({ ok: true, checked: 25 });
  });

  it('chains rows written inside a caller transaction, and rolls the row back with it', async () => {
    await write(1);
    await expect(
      t.db.transaction(async (tx) => {
        await core.audit.record({ ...actor, action: 'x', entityType: 'case', entityId: 'c', summary: 'rolled back' }, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await write(2);
    const rows = await t.db.select().from(auditEvents).orderBy(auditEvents.seq);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect((await core.audit.verifyChain()).ok).toBe(true);
  });

  it('rejects UPDATE and DELETE on a sealed row', async () => {
    await write(1);
    await expectAppendOnly(t.db.execute(sql`update audit_events set summary = 'edited'`));
    await expectAppendOnly(t.db.execute(sql`delete from audit_events`));
    expect((await core.audit.verifyChain()).ok).toBe(true);
  });

  it('fails verification and names the row when a stored row is edited', async () => {
    for (let i = 1; i <= 5; i++) await write(i);
    await asOwner(() => t.db.execute(sql`update audit_events set summary = 'tampered' where seq = 3`));
    const status = await core.audit.verifyChain();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'HASH_MISMATCH', checked: 2 });
  });

  it('fails when a jsonb value inside before/after is edited', async () => {
    await write(1);
    await write(2);
    await asOwner(() => t.db.execute(sql`update audit_events set after = '{"a":"x","z":99}'::jsonb where seq = 2`));
    expect(await core.audit.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2, reason: 'HASH_MISMATCH' });
  });

  it('fails when a row is deleted from the middle', async () => {
    for (let i = 1; i <= 5; i++) await write(i);
    await asOwner(() => t.db.execute(sql`delete from audit_events where seq = 2`));
    expect(await core.audit.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'SEQ_GAP' });
  });

  it('detects a cut tail only against a head saved earlier', async () => {
    for (let i = 1; i <= 3; i++) await write(i);
    const saved = (await core.audit.verifyChain()).head!;
    await asOwner(() => t.db.execute(sql`delete from audit_events where seq = 3`));
    expect((await core.audit.verifyChain()).ok).toBe(true);
    expect(await core.audit.verifyChain(saved)).toMatchObject({ ok: false, reason: 'TRUNCATED' });
  });

  it('seals rows that predate the chain, then blocks edits to them', async () => {
    await write(1);
    await asOwner(async () => {
      await t.db.execute(sql`insert into audit_events (id, at, actor_type, actor_id, actor_name, action, entity_type, entity_id, summary, seq)
        values ('audit_old1', '2026-09-01T00:00:00Z', 'SYSTEM', 'system', 'Reconciliation', 'old', 'case', 'c', 'legacy 1', 0)`);
    });
    // seq 0 sorts before the chained row, standing in for a row numbered by the migration.
    expect(await sealLegacyAuditRows(t.db)).toBe(1);
    expect(await sealLegacyAuditRows(t.db)).toBe(0);
    await expectAppendOnly(t.db.execute(sql`update audit_events set summary = 'x' where id = 'audit_old1'`));
  });

  it('exports every row as CSV, oldest first, with formulas defused', async () => {
    await write(1, { summary: '=HYPERLINK("http://x")' });
    await write(2, { summary: 'plain, with comma' });
    const lines: string[] = [];
    for await (const l of core.audit.exportCsv()) lines.push(l);
    expect(lines[0]).toContain('seq,id,at,actor_type');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`'=HYPERLINK`);
    expect(lines[2]).toContain('"plain, with comma"');
    const filtered: string[] = [];
    for await (const l of core.audit.exportCsv({ caseId: 'nope' })) filtered.push(l);
    expect(filtered).toHaveLength(1);
  });
});
