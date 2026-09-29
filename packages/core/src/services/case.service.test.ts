import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCore, type Core } from '../container';
import { cases, users } from '../db/schema';
import { buildMatrix } from '../reconciliation/matrix';
import { priorityOf, type CaseCandidate } from '../reconciliation/candidates';
import { healthySnapshot } from '../reconciliation/test-factory';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';
import { isOpenFingerprintConflict } from './case.service';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-28T12:00:00.000Z');

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

const matrix = buildMatrix(healthySnapshot());
const candidate = (o: Partial<CaseCandidate> = {}): CaseCandidate => ({
  fingerprint: 'PAYMENT_MISMATCH:pay_1',
  type: 'PAYMENT_MISMATCH',
  ruleIds: ['D1_CAPTURED_NOT_PAID'],
  severity: 'HIGH',
  priority: priorityOf('HIGH', 1_249_900),
  amountMinor: 1_249_900,
  entityRefs: { paymentId: 'pay_1', orderId: 'ord_1' },
  matrix,
  ...o,
});

const open = (c: CaseCandidate) => core.db.transaction((tx) => core.cases.openOrUpdate(c, tx));

describe('CaseService.openOrUpdate', () => {
  it('opens a case with a per-type display id and audits it', async () => {
    const a = await open(candidate());
    const b = await open(candidate({ fingerprint: 'REFUND_EXCEPTION:pay_1', type: 'REFUND_EXCEPTION', ruleIds: ['D5_REFUND_PENDING_SLA'] }));
    const c = await open(candidate({ fingerprint: 'PAYMENT_MISMATCH:pay_2' }));
    expect([a.case.displayId, b.case.displayId, c.case.displayId]).toEqual(['PAY-0001', 'RFD-0001', 'PAY-0002']);
    expect(a).toMatchObject({ created: true, changed: true });
    const audit = await core.audit.list({ limit: 10, caseId: a.case.id });
    expect(audit.items.map((i) => i.action)).toEqual(['case.opened']);
    expect(audit.items[0]?.summary).toBe('Opened PAY-0001: Payment mismatch for ₹12,499.00 (D1_CAPTURED_NOT_PAID)');
  });

  it('merges a repeat detection into the open case', async () => {
    const first = await open(candidate());
    const same = await open(candidate());
    expect(same).toMatchObject({ created: false, changed: false });
    const merged = await open(candidate({ ruleIds: ['D3_LEDGER_MISSING'], severity: 'MEDIUM' }));
    expect(merged.case.id).toBe(first.case.id);
    expect(merged.case.ruleIds).toEqual(['D1_CAPTURED_NOT_PAID', 'D3_LEDGER_MISSING']);
    expect(merged.case.severity).toBe('HIGH');
    expect(merged.changed).toBe(true);
    const audit = await core.audit.list({ limit: 10, caseId: first.case.id });
    expect(audit.items.map((i) => i.action).sort()).toEqual(['case.opened', 'case.updated']);
  });

  it('opens a new case once the previous one is resolved', async () => {
    const first = await open(candidate());
    await t.db.update(cases).set({ status: 'RESOLVED', resolvedAt: clock.now() }).where(eq(cases.id, first.case.id));
    const second = await open(candidate());
    expect(second.created).toBe(true);
    expect(second.case.displayId).toBe('PAY-0002');
  });

  it('recognises the open-fingerprint unique violation through Drizzle wrapping', () => {
    const pgError = { code: '23505', constraint: 'cases_open_fingerprint_uq' };
    expect(isOpenFingerprintConflict({ message: 'query failed', cause: pgError })).toBe(true);
    expect(isOpenFingerprintConflict({ code: '23505', constraint: 'cases_display_id_unique' })).toBe(false);
  });
});

describe('CaseService.list', () => {
  it('pages by priority, then age, with a stable cursor', async () => {
    const amounts = [5_000_00, 60_000_00, 12_000_00, 800_00, 30_000_00];
    for (const [i, amountMinor] of amounts.entries()) {
      clock.advance(1_000);
      await open(candidate({ fingerprint: `PAYMENT_MISMATCH:pay_${i}`, amountMinor, priority: priorityOf('HIGH', amountMinor) }));
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    let total: number | undefined;
    do {
      const page = await core.cases.list({ scope: 'open', limit: 2, cursor });
      seen.push(...page.items.map((i) => i.amountMinor));
      total = page.total;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([60_000_00, 30_000_00, 12_000_00, 5_000_00, 800_00]);
    expect(total).toBe(5);
    expect((await core.cases.list({ scope: 'closed', limit: 10 })).items).toEqual([]);
  });

  it('finds cases by display id, payment id prefix, and treats wildcards literally', async () => {
    const { case: c } = await open(candidate({ fingerprint: 'PAYMENT_MISMATCH:pay_findme' }));
    const byDisplay = await core.cases.list({ scope: 'all', limit: 10, q: c.displayId.toLowerCase() });
    expect(byDisplay.items.map((i) => i.id)).toEqual([c.id]);
    const wildcard = await core.cases.list({ scope: 'all', limit: 10, q: '%' });
    expect(wildcard.items).toEqual([]);
  });

  it('rejects a malformed cursor', async () => {
    await expect(core.cases.list({ scope: 'open', limit: 2, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('404s an unknown case', async () => {
    await expect(core.cases.get('case_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('case due time and overdue (D067)', () => {
  beforeEach(() => clock.set('2026-09-28T12:00:00.000Z'));

  it('sets dueAt from severity when the case opens', async () => {
    const high = await open(candidate());
    const low = await open(candidate({ fingerprint: 'PAYMENT_MISMATCH:pay_2', severity: 'LOW' }));
    expect(high.case.dueAt?.toISOString()).toBe('2026-09-28T20:00:00.000Z');
    expect(low.case.dueAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('does not move dueAt when a repeat detection raises severity', async () => {
    const first = await open(candidate({ severity: 'MEDIUM' }));
    const merged = await open(candidate({ severity: 'CRITICAL', ruleIds: ['D3_LEDGER_MISSING'] }));
    expect(merged.case.dueAt?.toISOString()).toBe(first.case.dueAt?.toISOString());
  });

  it('marks list items overdue only after dueAt, and lets the queue filter on it', async () => {
    const a = await open(candidate({ severity: 'CRITICAL' })); // due 16:00
    await open(candidate({ fingerprint: 'PAYMENT_MISMATCH:pay_2', severity: 'LOW' }));
    const later = createCore({ db: t.db, clock: fixedClock('2026-09-28T16:00:01.000Z') });
    const all = await later.cases.list({ limit: 10, scope: 'open' });
    expect(all.items.map((i) => [i.id, i.overdue])).toContainEqual([a.case.id, true]);
    expect(all.items.filter((i) => i.overdue)).toHaveLength(1);
    const overdue = await later.cases.list({ limit: 10, scope: 'open', overdue: true });
    expect(overdue.items.map((i) => i.id)).toEqual([a.case.id]);
    const early = await core.cases.list({ limit: 10, scope: 'open', overdue: true });
    expect(early.items).toEqual([]);
  });
});

describe('CaseService.assign', () => {
  const alice = { id: 'usr_alice', name: 'Ananya Rao', role: 'OPS' as const };
  const bob = { id: 'usr_bob', name: 'Rahul Menon', role: 'OPS' as const };
  const viewer = { id: 'usr_view', name: 'Kabir Shah', role: 'VIEWER' as const };

  beforeEach(async () => {
    await t.db.insert(users).values(
      [alice, bob, viewer].map((u) => ({ ...u, email: `${u.id}@payops.dev`, passwordHash: 'x' })),
    );
  });

  it('assigns, audits, and shows the assignee on the list and detail', async () => {
    const c = (await open(candidate())).case;
    const item = await core.cases.assign(c.id, bob.id, alice);
    expect(item.assignee).toEqual({ id: bob.id, name: bob.name });
    const audit = await core.audit.list({ limit: 10, caseId: c.id });
    // Same fixed-clock timestamp as case.opened, so find by action rather than by position.
    const event = audit.items.find((i) => i.action === 'case.assigned');
    expect(event).toMatchObject({ actor: { id: alice.id, name: alice.name } });
    expect(event?.summary).toBe('Assigned PAY-0001 to Rahul Menon');
  });

  it('reassigns and unassigns, auditing each change', async () => {
    const c = (await open(candidate())).case;
    await core.cases.assign(c.id, alice.id, alice);
    await core.cases.assign(c.id, bob.id, alice);
    const cleared = await core.cases.assign(c.id, null, alice);
    expect(cleared.assignee).toBeNull();
    const actions = (await core.audit.list({ limit: 10, caseId: c.id })).items.map((i) => i.action);
    expect(actions.filter((a) => a === 'case.assigned')).toHaveLength(2);
    expect(actions).toContain('case.unassigned');
  });

  it('does nothing and writes no audit row when the assignee is unchanged', async () => {
    const c = (await open(candidate())).case;
    await core.cases.assign(c.id, alice.id, alice);
    await core.cases.assign(c.id, alice.id, alice);
    const audit = await core.audit.list({ limit: 10, caseId: c.id });
    expect(audit.items.filter((i) => i.action === 'case.assigned')).toHaveLength(1);
  });

  it('rejects a viewer, an unknown user, an unknown case and a closed case', async () => {
    const c = (await open(candidate())).case;
    await expect(core.cases.assign(c.id, viewer.id, alice)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(core.cases.assign(c.id, 'usr_nope', alice)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(core.cases.assign('case_nope', alice.id, alice)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await core.db.update(cases).set({ status: 'RESOLVED' }).where(eq(cases.id, c.id));
    await expect(core.cases.assign(c.id, alice.id, alice)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('filters the queue by assignee, including unassigned', async () => {
    const a = (await open(candidate())).case;
    const b = (await open(candidate({ fingerprint: 'PAYMENT_MISMATCH:pay_2' }))).case;
    await core.cases.assign(a.id, alice.id, alice);
    const mine = await core.cases.list({ limit: 10, scope: 'open', assigneeId: alice.id });
    expect(mine.items.map((i) => i.id)).toEqual([a.id]);
    const none = await core.cases.list({ limit: 10, scope: 'open', assigneeId: 'unassigned' });
    expect(none.items.map((i) => i.id)).toEqual([b.id]);
  });
});
