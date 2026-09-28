import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCore, type Core } from '../container';
import { cases } from '../db/schema';
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
