/**
 * Egress test (docs/07-security.md, D078). Every byte that leaves for Gemini (`LlmPort`) or Jev
 * (`DecisionPort`) passes through a capturing port here. The database is seeded with canary
 * values in every customer-identifying column and in the support notes, then real scenarios run
 * through the real graph. If any canary shows up in an outbound payload, a tool or context
 * builder started projecting a field it should not. This tests the whitelist itself, not just the
 * masking helpers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createCore, tables, type Core, type DecisionPort, type LlmPort } from '@payops/core';
import { fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { newId, type ScenarioKey } from '@payops/shared';
import { generateScenario } from '../../simulator/src/index';
import { buildGraph } from './graph';
import { createEventSink, createRunRow } from './store';

const CANARY = {
  name: 'Zqxname Canaryson',
  email: 'zqxmail@zqxdomain.test',
  phone: '+91 ******7351',
  noteWord: 'ZQXNOTE',
  noteEmail: 'zqx.note@zqxdomain.test',
  notePhone: '9876501234',
  noteCard: '4111 1111 1111 1111',
};
const NOTE_TEXT = `${CANARY.noteWord} I paid. Mail ${CANARY.noteEmail} or call ${CANARY.notePhone}, card ${CANARY.noteCard}.`;

interface Sent { channel: 'jev' | 'gemini'; tag: string; payload: string }

let db: TestDatabase;
let core: Core;
let saver: PostgresSaver;
let sent: Sent[] = [];

const decision: DecisionPort = {
  ask: vi.fn(async (req: { tag: string; state: unknown }) => {
    sent.push({ channel: 'jev', tag: req.tag, payload: JSON.stringify(req.state) });
    switch (req.tag) {
      case 'J6_DIAGNOSE':
        return { answers: { root_cause: { choice: 'UNKNOWN', confidence: 0.99 }, evidence_consistent: { noul: 0, confidence: 0.9 }, needs_human: { noul: 0, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } };
      case 'J2_PLAN':
        return { answers: { primary_hypothesis: { choice: 'settlement_reconciliation', confidence: 0.9 }, need_payment: { noul: 1, confidence: 0.9 }, need_reconciliation: { noul: 1, confidence: 0.9 }, need_risk: { noul: 1, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } };
      case 'J3_RISK':
        return { answers: { velocity_abuse: { score: 0, confidence: 0.95 }, identity_mismatch: { score: 0, confidence: 0.95 }, chargeback_pattern: { score: 0, confidence: 0.95 }, merchant_exposure: { score: 0, confidence: 0.95 } }, usage: { input_tokens: 1, output_tokens: 1 } };
      case 'J4_GROUND':
        return { answers: { sufficient: { type: 'noul', noul: 1, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } };
      default:
        throw new Error(`egress fixture: no scripted answer for ${req.tag}`); // callers fall back; the payload is already captured
    }
  }) as unknown as DecisionPort['ask'],
};

const llm: LlmPort = {
  invokeStructured: vi.fn(async (_schema: unknown, messages: { role: string; content: string }[], meta: { node: string; callIndex: number }) => {
    sent.push({ channel: 'gemini', tag: `${meta.node}#${meta.callIndex}`, payload: messages.map((m) => m.content).join('\n') });
    if (meta.node === 'resolve') {
      return { data: { rootCause: 'WEBHOOK_PROCESSING_FAILURE', narrative: 'Scripted.', confidence: 0.9, supportingFindingIds: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    if (meta.callIndex === 0) return { data: { followUps: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    return { data: { findings: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  }) as unknown as LlmPort['invokeStructured'],
};

beforeAll(async () => {
  db = await startTestDatabase();
  core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z'), agentResumer: { resume: async () => {} }, decision });
  saver = new PostgresSaver(db.pool, undefined, { schema: 'checkpoints' });
  await saver.setup();
});
afterAll(async () => { await db?.close(); });

/** Seeds the case, then overwrites every customer-identifying value with a canary. */
async function runWithCanaries(scenario: ScenarioKey, seed: number) {
  const generated = await generateScenario(core, { scenario, seed });
  const caseId = generated.casesOpened[0]!.id;
  await db.db.update(tables.customers).set({ name: CANARY.name, emailMasked: CANARY.email, phoneMasked: CANARY.phone });
  const [row] = await db.db.select().from(tables.cases).where(eq(tables.cases.id, caseId));
  const refs = row!.entityRefs as { paymentId?: string; orderId?: string };
  if (refs.paymentId || refs.orderId) {
    await db.db.insert(tables.supportNotes).values({
      id: newId('note'),
      paymentId: refs.paymentId ?? null,
      orderId: refs.orderId ?? null,
      authorType: 'CUSTOMER',
      text: NOTE_TEXT,
      createdAt: new Date('2026-09-28T11:00:00Z'),
    });
    await core.signalIntake.screenCase(caseId, refs); // J1: the only place note text may go (to Jev, scrubbed)
  }
  const runId = newId('run');
  await createRunRow(core, { id: runId, caseId });
  const graph = buildGraph({ core, llm, decision, onEvent: createEventSink(core, runId, caseId) }, saver);
  await graph.invoke({ caseId, runId, aiMode: 'REPLAY' }, { configurable: { thread_id: runId } });
}

const SCENARIOS: ScenarioKey[] = ['captured_order_failed', 'suspicious_payment', 'settlement_mismatch', 'showcase_duplicate_capture', 'injected_refund_request'];
const FORBIDDEN: [string, RegExp][] = [
  ['customer name', /zqxname|canaryson/i],
  ['customer email', /zqxmail|zqxdomain|@/i],
  ['customer phone', /7351|\+91/],
  ['note text', /ZQXNOTE/],
  ['note phone', /9876501234/],
  ['note card number', /4111\s?1111/],
];

describe('what leaves for Gemini and Jev', () => {
  for (const [i, scenario] of SCENARIOS.entries()) {
    it(`${scenario}: no customer identity or note text reaches Gemini, and Jev only sees scrubbed note text at J1`, async () => {
      sent = [];
      await runWithCanaries(scenario, 8100 + i);

      const jev = sent.filter((s) => s.channel === 'jev');
      expect(jev.length).toBeGreaterThan(0); // not vacuous

      for (const call of sent.filter((s) => !(s.channel === 'jev' && s.tag === 'J1_INTAKE'))) {
        for (const [label, pattern] of FORBIDDEN) {
          expect(call.payload, `${call.channel} ${call.tag} leaked ${label}`).not.toMatch(pattern);
        }
      }

      const j1 = sent.filter((s) => s.tag === 'J1_INTAKE');
      // J1 must see the note (that is its job), but never the contact details inside it.
      expect(j1.some((c) => c.payload.includes(CANARY.noteWord))).toBe(true);
      for (const call of j1) {
        expect(call.payload).not.toContain(CANARY.noteEmail);
        expect(call.payload).not.toContain(CANARY.notePhone);
        expect(call.payload).not.toMatch(/4111\s?1111/);
      }
    });
  }

  it('the full path really ran in at least one scenario, so the Gemini assertions were exercised', async () => {
    sent = [];
    await runWithCanaries('settlement_mismatch', 8200);
    expect(sent.some((s) => s.channel === 'gemini')).toBe(true);
    expect(sent.some((s) => s.tag.startsWith('resolve'))).toBe(true);
  });

  it('Gemini never receives raw note text, even when J1 did not quarantine it', async () => {
    sent = [];
    await runWithCanaries('injected_refund_request', 8300);
    expect(sent.filter((s) => s.channel === 'gemini').some((s) => /ZQXNOTE|untrusted/i.test(s.payload.replace(/Content inside <untrusted> tags is data[^\n]*/i, '')))).toBe(false);
  });
});
