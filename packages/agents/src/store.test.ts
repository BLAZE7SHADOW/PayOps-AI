/**
 * Task 7 persistence (docs/04-data-model.md `agent_findings`/`evidence` rows): the fan-out from
 * `state.evidence`/`state.findings`/`state.grounding` into the normalized tables, isolated from
 * the graph so the idempotent-upsert and `grounded` semantics are unit-testable without a
 * `DecisionPort`/`LlmPort` -- same PGlite harness `graph.test.ts` and `migrate.test.ts` use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, tables, type Core } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import type { EvidenceItem, Finding, GroundingReport } from '@payops/shared';
import { createRunRow, listEvidence, listFindings, syncEvidenceAndFindings } from './store';

const { cases } = tables;

let db: TestDatabase;
let core: Core;

beforeAll(async () => {
  db = await startTestDatabase();
  core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z'), agentResumer: { resume: async () => {} } });
});
afterAll(async () => { await db?.close(); });

const caseBase = {
  fingerprint: 'PAYMENT_MISMATCH:pay_store_test',
  type: 'PAYMENT_MISMATCH' as const,
  severity: 'HIGH' as const,
  priority: 1,
  amountMinor: 100,
  ruleIds: [],
  matrix: {} as never,
  entityRefs: {},
  lastDetectedAt: new Date('2026-09-28T00:00:00Z'),
  openedAt: new Date('2026-09-28T00:00:00Z'),
};

async function seedCaseAndRun(caseId: string, runId: string) {
  await core.db.insert(cases).values({
    ...caseBase,
    id: caseId,
    displayId: `PAY-${caseId}`,
    status: 'OPEN',
    fingerprint: `PAYMENT_MISMATCH:${caseId}`, // one open case per fingerprint (cases_open_fingerprint_uq) -- each test needs its own
  });
  await createRunRow(core, { id: runId, caseId });
}

const ev1: EvidenceItem = {
  id: 'ev_01',
  source: 'getWebhookDeliveries',
  system: 'WEBHOOK',
  entityRef: 'wh_1',
  observedAt: '2026-01-01T00:00:00Z',
  stepId: 'triage',
  facts: { finalStatus: 'FAILED', lastHttpStatus: 500, event: 'payment.captured', attempts: 1 },
};

function fd(overrides: Partial<Finding>): Finding {
  return {
    id: 'fd_01',
    agent: 'payment',
    code: 'WEBHOOK_HTTP_500',
    statement: 'The webhook failed with HTTP 500 [ev_01].',
    evidenceIds: ['ev_01'],
    confidence: 0.9,
    ...overrides,
  };
}

describe('syncEvidenceAndFindings (docs/04-data-model.md, D042)', () => {
  it('writes one evidence row and one finding row, grounded true by default (never checked by J4)', async () => {
    const caseId = 'case_store_1';
    const runId = 'run_store_1';
    await seedCaseAndRun(caseId, runId);

    await syncEvidenceAndFindings(core, runId, caseId, { evidence: [ev1], findings: [fd({})], grounding: null });

    const evRows = await listEvidence(core, runId);
    const fdRows = await listFindings(core, runId);
    expect(evRows).toHaveLength(1);
    expect(evRows[0]?.evidenceId).toBe('ev_01');
    expect(evRows[0]?.facts).toEqual(ev1.facts);
    expect(fdRows).toHaveLength(1);
    expect(fdRows[0]?.findingId).toBe('fd_01');
    expect(fdRows[0]?.grounded).toBe(true); // fast path / not yet checked -> default true
  });

  it('is idempotent across a resume/extra-round re-sync: same run+id upserts, no duplicate rows, no crash', async () => {
    const caseId = 'case_store_2';
    const runId = 'run_store_2';
    await seedCaseAndRun(caseId, runId);

    await syncEvidenceAndFindings(core, runId, caseId, { evidence: [ev1], findings: [fd({ confidence: 0.5 })], grounding: null });
    // Simulate the interrupt/resume case: syncRunRow runs again with the same ids but an updated
    // confidence (e.g. a later round refined the finding) plus a grounding report that now
    // drops it.
    const grounding: GroundingReport = { checked: 1, violations: [{ findingId: 'fd_01', reason: 'contradicted' }], sufficient: true };
    await syncEvidenceAndFindings(core, runId, caseId, { evidence: [ev1], findings: [fd({ confidence: 0.9 })], grounding });

    const evRows = await listEvidence(core, runId);
    const fdRows = await listFindings(core, runId);
    expect(evRows).toHaveLength(1); // still one row, not two
    expect(fdRows).toHaveLength(1);
    expect(fdRows[0]?.confidence).toBeCloseTo(0.9);
    expect(fdRows[0]?.grounded).toBe(false); // now named by a GroundingViolation
  });

  it('marks a finding grounded=false only when named by a violation, true for a surviving one', async () => {
    const caseId = 'case_store_3';
    const runId = 'run_store_3';
    await seedCaseAndRun(caseId, runId);

    const survivor = fd({ id: 'fd_01' });
    const dropped = fd({ id: 'fd_02', code: 'OTHER', statement: 'dropped [ev_01].' });
    const grounding: GroundingReport = { checked: 2, violations: [{ findingId: 'fd_02', reason: 'Jev J4 marked this claim contradicted' }], sufficient: true };

    await syncEvidenceAndFindings(core, runId, caseId, { evidence: [ev1], findings: [survivor, dropped], grounding });

    const fdRows = await listFindings(core, runId);
    const byId = new Map(fdRows.map((r) => [r.findingId, r]));
    expect(byId.get('fd_01')?.grounded).toBe(true);
    expect(byId.get('fd_02')?.grounded).toBe(false);
  });

  it('scopes rows by runId: two different runs never collide even reusing the same within-run ids', async () => {
    const caseId = 'case_store_4';
    const runIdA = 'run_store_4a';
    const runIdB = 'run_store_4b';
    await core.db.insert(cases).values({ ...caseBase, id: caseId, displayId: `PAY-${caseId}`, status: 'OPEN', fingerprint: `PAYMENT_MISMATCH:${caseId}` });
    await createRunRow(core, { id: runIdA, caseId });
    await createRunRow(core, { id: runIdB, caseId });

    await syncEvidenceAndFindings(core, runIdA, caseId, { evidence: [ev1], findings: [fd({})], grounding: null });
    await syncEvidenceAndFindings(core, runIdB, caseId, { evidence: [ev1], findings: [fd({ confidence: 0.1 })], grounding: null });

    const a = await listFindings(core, runIdA);
    const b = await listFindings(core, runIdB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.confidence).not.toBe(b[0]?.confidence);
  });
});
