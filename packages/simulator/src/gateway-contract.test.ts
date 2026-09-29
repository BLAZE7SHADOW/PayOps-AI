import { afterAll, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCore, tables, type Core } from '@payops/core';
import { describeGatewayContract, fixedClock, startTestDatabase, type TestDatabase } from '@payops/core/testing';
import { generateScenario, resetDemoData } from './index';

// The simulator adapter must satisfy the same contract a real gateway adapter will.
let t: TestDatabase;
let core: Core;

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock: fixedClock('2026-09-28T12:00:00.000Z') });
});
afterAll(async () => {
  await t.close();
});

describeGatewayContract('simulator', {
  setup: async () => {
    await resetDemoData(core);
    const { created } = await generateScenario(core, { scenario: 'healthy_payment', seed: 1 });
    // Our payment record points at the gateway payment it was captured as.
    const [payment] = await core.db.select().from(tables.payments).where(eq(tables.payments.id, created.paymentIds[0]!));
    return { gateway: core.gateway, gwPaymentId: payment!.gwPaymentId!, settled: true };
  },
});
