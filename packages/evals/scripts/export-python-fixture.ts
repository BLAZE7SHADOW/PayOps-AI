/**
 * Writes `python/agents/tests/fixtures/captured_order_failed.json`: the case brief and every tool's output
 * for one recorded scenario, taken from the real API. The Python tests serve it from a fake API, so a whole
 * run replays against the recorded cassette with no Node process (D085). Regenerate it when a tool's output
 * or the simulator's data changes: `tsx packages/evals/scripts/export-python-fixture.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCore, loadServerEnv } from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { ALL_TOOLS, remoteCaseBrief, remoteProposal, remoteRunTools } from '@payops/agents';
import { generateScenario } from '../../simulator/src/index';

async function main() {
  loadServerEnv({ NODE_ENV: 'test' });
  const db = await startTestDatabase();
  try {
    const core = createCore({ db: db.db, clock: fixedClock('2026-09-28T12:00:00Z') });
    const made = await generateScenario(core, { scenario: 'captured_order_failed', seed: 3201 });
    const caseId = made.casesOpened[0]!.id;
    const { brief, entityRefs } = await remoteCaseBrief(core, caseId);
    const results = await remoteRunTools(core, caseId, ALL_TOOLS.map((t) => t.name));
    const tools = Object.fromEntries(results.map((r) => [r.tool, r.drafts]));
    const proposal = await remoteProposal(
      core,
      caseId,
      { rootCause: 'WEBHOOK_PROCESSING_FAILURE', narrative: 'x', confidence: 0.99, supportingFindingIds: [], path: 'FAST' },
      [],
    );
    const out = resolve(import.meta.dirname, '../../../python/agents/tests/fixtures/captured_order_failed.json');
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ scenarioKey: 'captured_order_failed', caseId, brief, entityRefs, tools, proposalActions: proposal.actions }, null, 2)}\n`);
    console.warn(`wrote ${out}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
