import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MAX_SAVED_VIEWS_PER_USER } from '@payops/shared';
import { createCore, type Core } from '../container';
import { cases, users } from '../db/schema';
import { buildMatrix } from '../reconciliation/matrix';
import { priorityOf, type CaseCandidate } from '../reconciliation/candidates';
import { healthySnapshot } from '../reconciliation/test-factory';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-28T12:00:00.000Z');
const alice = { id: 'usr_alice', name: 'Ananya Rao', role: 'OPS' as const };
const bob = { id: 'usr_bob', name: 'Rahul Menon', role: 'OPS' as const };

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock.set('2026-09-28T12:00:00.000Z');
  await t.reset();
  await t.db.insert(users).values([alice, bob].map((u) => ({ ...u, email: `${u.id}@payops.dev`, passwordHash: 'x' })));
});

const matrix = buildMatrix(healthySnapshot());
const candidate = (n: number, o: Partial<CaseCandidate> = {}): CaseCandidate => ({
  fingerprint: `PAYMENT_MISMATCH:pay_${n}`,
  type: 'PAYMENT_MISMATCH',
  ruleIds: ['D1_CAPTURED_NOT_PAID'],
  severity: 'HIGH',
  priority: priorityOf('HIGH', 1_000_00 * n),
  amountMinor: 1_000_00 * n,
  entityRefs: { paymentId: `pay_${n}`, orderId: `ord_${n}` },
  matrix,
  ...o,
});
const open = async (c: CaseCandidate) => (await core.db.transaction((tx) => core.cases.openOrUpdate(c, tx))).case;

describe('case notes', () => {
  it('adds a note, audits it and lists newest first', async () => {
    const c = await open(candidate(1));
    const first = await core.caseNotes.add(c.id, { text: '  Called the merchant.  ' }, alice);
    clock.advance(60_000);
    await core.caseNotes.add(c.id, { text: 'Waiting on their bank.' }, bob);
    expect(first).toMatchObject({ caseId: c.id, text: 'Called the merchant.', authorId: alice.id, authorName: alice.name });
    const list = await core.caseNotes.list(c.id);
    expect(list.map((n) => n.text)).toEqual(['Waiting on their bank.', 'Called the merchant.']);
    const audits = (await core.audit.list({ limit: 10, caseId: c.id })).items.filter((i) => i.action === 'case.note_added');
    expect(audits.map((a) => a.actor.id).sort()).toEqual([alice.id, bob.id]);
  });

  it('allows a note on a resolved case and rejects an unknown case', async () => {
    const c = await open(candidate(1));
    await core.db.update(cases).set({ status: 'RESOLVED' }).where(eq(cases.id, c.id));
    await expect(core.caseNotes.add(c.id, { text: 'Closed with the bank.' }, alice)).resolves.toMatchObject({ caseId: c.id });
    await expect(core.caseNotes.add('case_nope', { text: 'x' }, alice)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(core.caseNotes.list('case_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('saved views', () => {
  it('saves, lists and deletes a view for its owner only', async () => {
    const v = await core.savedViews.save(alice.id, { name: 'My overdue', filters: { overdue: true, assigneeId: 'me' } });
    expect(v).toMatchObject({ name: 'My overdue', filters: { overdue: true, assigneeId: 'me' } });
    expect((await core.savedViews.list(alice.id)).map((x) => x.id)).toEqual([v.id]);
    expect(await core.savedViews.list(bob.id)).toEqual([]);
    await expect(core.savedViews.remove(bob.id, v.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await core.savedViews.remove(alice.id, v.id);
    expect(await core.savedViews.list(alice.id)).toEqual([]);
  });

  it('rejects a duplicate name for the same user but allows it for another user', async () => {
    await core.savedViews.save(alice.id, { name: 'Critical', filters: { severity: 'CRITICAL' } });
    await expect(core.savedViews.save(alice.id, { name: 'Critical', filters: {} })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(core.savedViews.save(bob.id, { name: 'Critical', filters: {} })).resolves.toMatchObject({ name: 'Critical' });
  });

  it('caps the number of views per user', async () => {
    for (let i = 0; i < MAX_SAVED_VIEWS_PER_USER; i++) await core.savedViews.save(alice.id, { name: `v${i}`, filters: {} });
    await expect(core.savedViews.save(alice.id, { name: 'one too many', filters: {} })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('shift handoff', () => {
  it('counts open work and lists what needs attention, most urgent first', async () => {
    const overdue = await open(candidate(1, { severity: 'MEDIUM', priority: priorityOf('MEDIUM', 100_00) }));
    clock.advance(30 * 3_600_000); // the MEDIUM case is now past its 24h window
    const critical = await open(candidate(2, { severity: 'CRITICAL', priority: priorityOf('CRITICAL', 9_000_00) }));
    const waiting = await open(candidate(3));
    await core.db.update(cases).set({ status: 'AWAITING_APPROVAL', assigneeId: bob.id }).where(eq(cases.id, waiting.id));
    await open(candidate(4, { severity: 'LOW', priority: priorityOf('LOW', 10_00) }));

    const h = await core.handoff.summary(8);
    expect(h.open).toMatchObject({ total: 4, overdue: 1, awaitingApproval: 1, unassigned: 3 });
    expect(h.open.bySeverity).toMatchObject({ CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 });
    expect(h.needsAttention.map((c) => c.displayId)).toEqual(
      [critical, waiting, overdue].sort((a, b) => b.priority - a.priority).map((c) => c.displayId),
    );
    const byId = Object.fromEntries(h.needsAttention.map((c) => [c.id, c]));
    expect(byId[overdue.id]?.reasons).toEqual(['Overdue']);
    expect(byId[critical.id]?.reasons).toEqual(['Critical']);
    expect(byId[waiting.id]?.reasons).toEqual(['Waiting for approval']);
    expect(byId[waiting.id]?.assigneeName).toBe(bob.name);
  });

  it('includes the newest note per case and recent notes inside the window only', async () => {
    const c = await open(candidate(1, { severity: 'CRITICAL' }));
    await core.caseNotes.add(c.id, { text: 'Old note.' }, alice);
    clock.advance(10 * 3_600_000);
    await core.caseNotes.add(c.id, { text: 'Fresh note.' }, bob);
    const h = await core.handoff.summary(8);
    expect(h.needsAttention[0]?.lastNote).toMatchObject({ text: 'Fresh note.', authorName: bob.name });
    expect(h.recentNotes.map((n) => n.text)).toEqual(['Fresh note.']);
    expect(h.recentNotes[0]).toMatchObject({ displayId: c.displayId });
  });

  it('counts cases resolved inside the window by who resolved them', async () => {
    const a = await open(candidate(1));
    const b = await open(candidate(2));
    const old = await open(candidate(3));
    const now = clock.now();
    const set = (id: string, by: 'AGENT' | 'USER', at: Date) =>
      core.db.update(cases).set({ status: 'RESOLVED', resolvedAt: at, resolution: { by, summary: 's', runId: null } }).where(eq(cases.id, id));
    await set(a.id, 'AGENT', now);
    await set(b.id, 'USER', new Date(now.getTime() - 3_600_000));
    await set(old.id, 'AGENT', new Date(now.getTime() - 20 * 3_600_000));
    const h = await core.handoff.summary(8);
    expect(h.resolved).toEqual({ total: 2, by: { AGENT: 1, USER: 1, SYSTEM: 0 } });
    expect(h.open.total).toBe(0);
    expect(h.needsAttention).toEqual([]);
  });

  it('caps needs-attention at ten cases', async () => {
    for (let i = 1; i <= 12; i++) await open(candidate(i, { severity: 'CRITICAL' }));
    const h = await core.handoff.summary(8);
    expect(h.open.total).toBe(12);
    expect(h.needsAttention).toHaveLength(10);
  });
});
